import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOperationHandoff, classifyEvidence, currentState, lastRun, repositoryCurrency, repositoryTree, searchRepository } from './core.mjs';

const staticRoot = join(dirname(fileURLToPath(import.meta.url)), 'visual-prototype');
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};

function json(response, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function jsonBody(request, limit = 16 * 1024) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) throw Object.assign(new Error('Operation request is too large.'), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Operation request is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Operation request must be valid JSON.'), { statusCode: 400 }); }
}

function searchRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Search request must be an object.'), { statusCode: 400 });
  const unknown = Object.keys(value).filter((key) => !['query', 'scope'].includes(key));
  if (unknown.length) throw Object.assign(new Error(`Unsupported search fields: ${unknown.join(', ')}`), { statusCode: 400 });
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 500) throw Object.assign(new Error('Search query must be 1-500 characters.'), { statusCode: 400 });
  if (value.scope !== undefined && (typeof value.scope !== 'string' || !value.scope || value.scope.length > 500)) throw Object.assign(new Error('Search scope must be a repository-relative string.'), { statusCode: 400 });
  return { query: value.query, scope: value.scope || '.' };
}

function validateOperationRequest(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Operation requests require application/json.'), { statusCode: 415 });
  }
  const origin = request.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch {}
    if (!originHost || originHost !== request.headers.host) {
      throw Object.assign(new Error('Cross-origin operation requests are not allowed.'), { statusCode: 403 });
    }
  }
}

function projectedPaths(directory, result = new Set()) {
  for (const file of directory.files) result.add(file.path);
  for (const child of directory.directories) projectedPaths(child, result);
  return result;
}

async function sourceExcerpt(project, requested, context = 2) {
  const path = String(requested || '').replaceAll('\\', '/');
  const tree = await repositoryTree(project.root);
  if (!path || !projectedPaths(tree.root).has(path)) throw Object.assign(new Error('Source file is not in the current repository projection.'), { statusCode: 404 });
  const record = lastRun(project);
  const match = record?.operation?.type === 'search' ? record.operation.files.find((file) => file.path === path) : null;
  if (!match) throw Object.assign(new Error('Source excerpts require a matching file from the latest Search operation.'), { statusCode: 409 });
  const radius = Number(context);
  if (!Number.isInteger(radius) || radius < 0 || radius > 10) throw Object.assign(new Error('Source context must be an integer from 0 to 10.'), { statusCode: 400 });
  const target = resolve(project.root, ...path.split('/'));
  const metadata = statSync(target);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) throw Object.assign(new Error('Source preview supports files up to 1 MiB.'), { statusCode: 413 });
  const content = readFileSync(target, 'utf8');
  if (content.includes('\0')) throw Object.assign(new Error('Binary files cannot be displayed as source.'), { statusCode: 415 });
  const lines = content.split(/\r?\n/);
  const excerpts = match.lines.map((line) => {
    const startLine = Math.max(1, line - radius);
    const endLine = Math.min(lines.length, line + radius);
    return {
      matchLine: line, startLine, endLine,
      lines: lines.slice(startLine - 1, endLine).map((text, index) => ({ number: startLine + index, text, match: startLine + index === line })),
    };
  });
  return {
    path, query: record.operation.query, runId: record.id,
    evidence: classifyEvidence(record.currencyAfter, await repositoryCurrency(project.root)),
    excerpts,
  };
}

function safeStaticPath(pathname) {
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const target = resolve(staticRoot, normalize(relativePath));
  const inside = relative(staticRoot, target);
  return inside === '' || (!inside.startsWith('..') && !resolve(inside).startsWith('..')) ? target : null;
}

function sendFile(request, response, path, { cache = 'no-cache' } = {}) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const size = statSync(path).size;
  const type = contentTypes[extname(path).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes ${'*'}/${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1, 'Content-Type': type, 'Cache-Control': cache,
    });
    createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    'Accept-Ranges': 'bytes', 'Content-Length': size,
    'Content-Type': type, 'Cache-Control': cache,
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(path).pipe(response);
}

export function createHudServer(project) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/operations/search') {
        validateOperationRequest(request);
        const operation = searchRequest(await jsonBody(request));
        let record;
        try { record = await searchRepository(project, operation.query, operation.scope); }
        catch (error) {
          if (/Search scope (?:is outside|does not exist)/.test(error.message)) error.statusCode = 400;
          throw error;
        }
        json(response, 200, {
          runId: record.id,
          status: record.status,
          operation: record.operation,
          evidence: { stdout: record.stdoutPath, stderr: record.stderrPath },
          state: await currentState(project),
        });
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        json(response, 405, { error: 'Only the typed Search operation accepts local mutation requests.' });
        return;
      }
      if (url.pathname === '/state' || url.pathname === '/visual-state') {
        json(response, 200, await currentState(project));
        return;
      }
      if (url.pathname === '/tree') {
        json(response, 200, await repositoryTree(project.root));
        return;
      }
      if (url.pathname === '/handoff') {
        const record = lastRun(project);
        if (!record?.operation) throw Object.assign(new Error('No structured operation is available to hand off.'), { statusCode: 404 });
        json(response, 200, { runId: record.id, handoff: buildOperationHandoff(project, record) });
        return;
      }
      if (url.pathname === '/source') {
        json(response, 200, await sourceExcerpt(project, url.searchParams.get('path'), url.searchParams.get('context') ?? 2));
        return;
      }
      if (url.pathname === '/media') {
        const requested = String(url.searchParams.get('path') || '').replaceAll('\\', '/');
        const tree = await repositoryTree(project.root);
        if (!requested || !projectedPaths(tree.root).has(requested)) {
          json(response, 404, { error: 'Repository file is not in the current projection.' });
          return;
        }
        const target = resolve(project.root, ...requested.split('/'));
        const inside = relative(project.root, target);
        if (!inside || inside.startsWith('..')) {
          json(response, 403, { error: 'Repository path is outside the verified root.' });
          return;
        }
        sendFile(request, response, target, { cache: 'no-store' });
        return;
      }
      const target = safeStaticPath(url.pathname);
      if (!target) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      sendFile(request, response, target);
    } catch (error) {
      json(response, error.statusCode || 500, { error: error.message });
    }
  });
}

export async function startHudServer(project, { host = '127.0.0.1', port = 8765 } = {}) {
  const server = createHudServer(project);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  return { server, host, port: typeof address === 'object' ? address.port : port };
}
