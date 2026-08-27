import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCurrentOperationContext, classifyEvidence, currentState, discoverShells, lastRun, operationDetail, operationHistory, recoverInterruptedRuns, repositoryCurrency, repositoryTree, runById, runRepositoryCommand, runTerminalCommand, searchRepository, undoOperation, undoPlan } from './core.mjs';

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

function repositoryCommandRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Repository command request must be an object.'), { statusCode: 400 });
  const unknown = Object.keys(value).filter((key) => key !== 'name');
  if (unknown.length) throw Object.assign(new Error(`Unsupported repository command fields: ${unknown.join(', ')}`), { statusCode: 400 });
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw Object.assign(new Error('Repository command name must be 1-200 characters.'), { statusCode: 400 });
  return { name: value.name };
}

function terminalCommandRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Terminal request must be an object.'), { statusCode: 400 });
  const unknown = Object.keys(value).filter((key) => !['command', 'shell'].includes(key));
  if (unknown.length) throw Object.assign(new Error(`Unsupported terminal fields: ${unknown.join(', ')}`), { statusCode: 400 });
  if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 32 * 1024) throw Object.assign(new Error('Terminal command must be 1-32768 characters.'), { statusCode: 400 });
  if (typeof value.shell !== 'string' || !['powershell', 'bash', 'cmd'].includes(value.shell)) throw Object.assign(new Error('Terminal shell must be powershell, bash, or cmd.'), { statusCode: 400 });
  return { command: value.command, shell: value.shell };
}

function undoRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Undo request must be an object.'), { statusCode: 400 });
  const unknown = Object.keys(value).filter((key) => key !== 'runId');
  if (unknown.length) throw Object.assign(new Error(`Unsupported Undo fields: ${unknown.join(', ')}`), { statusCode: 400 });
  if (typeof value.runId !== 'string' || !/^\d{14}-[0-9a-f]{4}$/i.test(value.runId)) throw Object.assign(new Error('Undo requires a valid recorded run ID.'), { statusCode: 400 });
  return { runId: value.runId };
}

function cancelRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Cancel request must be an object.'), { statusCode: 400 });
  const unknown = Object.keys(value).filter((key) => key !== 'runId');
  if (unknown.length) throw Object.assign(new Error(`Unsupported Cancel fields: ${unknown.join(', ')}`), { statusCode: 400 });
  if (typeof value.runId !== 'string' || !/^\d{14}-[0-9a-f]{4}$/i.test(value.runId)) throw Object.assign(new Error('Cancel requires the active run ID.'), { statusCode: 400 });
  return { runId: value.runId };
}

function navigationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Navigation request must be an object.'), { statusCode: 400 });
  const unknown = Object.keys(value).filter((key) => !['clientId', 'directory', 'file'].includes(key));
  if (unknown.length) throw Object.assign(new Error(`Unsupported navigation fields: ${unknown.join(', ')}`), { statusCode: 400 });
  if (typeof value.clientId !== 'string' || !/^[A-Za-z0-9._-]{8,100}$/.test(value.clientId)) throw Object.assign(new Error('Navigation requires a valid client identity.'), { statusCode: 400 });
  for (const key of ['directory', 'file']) {
    if (value[key] !== null && value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1000)) throw Object.assign(new Error(`Navigation ${key} must be a bounded repository path or null.`), { statusCode: 400 });
  }
  return { clientId: value.clientId, directory: value.directory || '', file: value.file || null };
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

function projectedDirectories(directory, result = new Set([''])) {
  result.add(directory.path || '');
  for (const child of directory.directories) projectedDirectories(child, result);
  return result;
}

function boundedEvidence(path, tail = 200) {
  const count = Number(tail);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw Object.assign(new Error('Evidence tail must be an integer from 1 to 500 lines.'), { statusCode: 400 });
  if (!path || !existsSync(path)) return { size: 0, complete: true, returnedBytes: 0, text: '' };
  const size = statSync(path).size;
  const maximum = 64 * 1024;
  const start = Math.max(0, size - maximum);
  const buffer = Buffer.alloc(size - start);
  const descriptor = openSync(path, 'r');
  try { readSync(descriptor, buffer, 0, buffer.length, start); } finally { closeSync(descriptor); }
  const decoded = buffer.toString('utf8');
  const lines = decoded.split(/\r?\n/);
  if (start > 0) lines.shift();
  const selected = lines.slice(-count);
  return { size, complete: start === 0 && selected.length >= lines.length, returnedBytes: Buffer.byteLength(selected.join('\n')), text: selected.join('\n') };
}

function evidenceTail(project, runId, stream, tail = 200) {
  const record = runById(project, runId);
  if (!record) throw Object.assign(new Error('Recorded run was not found.'), { statusCode: 404 });
  const path = stream === 'stdout' ? record.stdoutPath : record.stderrPath;
  if (!path) throw Object.assign(new Error(`Recorded ${stream} evidence is unavailable.`), { statusCode: 404 });
  return { runId: record.id, stream, ...boundedEvidence(path, tail) };
}

async function sourceExcerpt(project, requested, context = 2, runId = null) {
  const path = String(requested || '').replaceAll('\\', '/');
  const tree = await repositoryTree(project.root);
  if (!path || !projectedPaths(tree.root).has(path)) throw Object.assign(new Error('Source file is not in the current repository projection.'), { statusCode: 404 });
  const record = runId ? runById(project, runId) : lastRun(project);
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
    evidence: classifyEvidence(record.currencyAfter, await repositoryCurrency(project.root, project.identity.id)),
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

export function createHudServer(project, { terminal = false, onSessionClientsChanged = null } = {}) {
  let activeOperation = null;
  let activeExecution = null;
  let terminalCwd = project.root;
  let eventSequence = 0;
  const eventClients = new Set();
  let navigation = { revision: 0, clientId: null, directory: '', file: null, updatedAt: null };
  const publish = (type, payload = {}) => {
    const event = { id: ++eventSequence, type, at: new Date().toISOString(), ...payload };
    const body = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of eventClients) response.write(body);
    return event;
  };
  const runTypedOperation = async (type, label, action, { cancellable = false } = {}) => {
    if (activeOperation) {
      const error = Object.assign(new Error(`CommandHUD is busy with ${activeOperation.type}: ${activeOperation.label}`), { statusCode: 409 });
      error.busy = activeOperation;
      throw error;
    }
    const controller = new AbortController();
    activeOperation = { type, label, state: 'starting', startedAt: new Date().toISOString(), runId: null, cancellable };
    publish('operation', { operation: activeOperation });
    activeExecution = { controller, stdoutPath: null, stderrPath: null };
    const onStart = (value) => {
      activeOperation = { ...activeOperation, state: 'running', runId: value.runId, command: value.command, startedAt: value.startedAt };
      activeExecution.stdoutPath = value.stdoutPath;
      activeExecution.stderrPath = value.stderrPath;
      publish('operation', { operation: activeOperation });
    };
    try {
      const record = await action({ signal: controller.signal, onStart });
      publish('state', { reason: 'operation-complete', runId: record.id, status: record.status, operationType: record.operation?.type || type });
      return record;
    } finally {
      activeOperation = null; activeExecution = null;
      publish('operation', { operation: null });
    }
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', session: project.key, eventSequence })}\n\n`);
        eventClients.add(response);
        onSessionClientsChanged?.(eventClients.size);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
        heartbeat.unref?.();
        request.on('close', () => {
          clearInterval(heartbeat);
          eventClients.delete(response);
          onSessionClientsChanged?.(eventClients.size);
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/operations/search') {
        validateOperationRequest(request);
        const operation = searchRequest(await jsonBody(request));
        let record;
        try { record = await runTypedOperation('search', `${operation.query} in ${operation.scope}`, () => searchRepository(project, operation.query, operation.scope, { origin: 'local-server' })); }
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
      if (request.method === 'POST' && url.pathname === '/operations/cancel') {
        validateOperationRequest(request);
        const operation = cancelRequest(await jsonBody(request));
        if (!activeOperation || !activeExecution || activeOperation.runId !== operation.runId || !activeOperation.cancellable) {
          throw Object.assign(new Error('The requested run is not the active cancellable operation.'), { statusCode: 409 });
        }
        activeOperation = { ...activeOperation, state: 'cancelling' };
        publish('operation', { operation: activeOperation });
        activeExecution.controller.abort();
        json(response, 202, { runId: operation.runId, status: 'cancelling' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/session/navigation') {
        validateOperationRequest(request);
        const requested = navigationRequest(await jsonBody(request));
        const tree = await repositoryTree(project.root);
        const files = projectedPaths(tree.root);
        const directories = projectedDirectories(tree.root);
        if (!directories.has(requested.directory)) throw Object.assign(new Error('Navigation directory is not in the current repository projection.'), { statusCode: 400 });
        if (requested.file && !files.has(requested.file)) throw Object.assign(new Error('Navigation file is not in the current repository projection.'), { statusCode: 400 });
        navigation = { ...requested, revision: navigation.revision + 1, updatedAt: new Date().toISOString() };
        publish('navigation', { navigation });
        json(response, 200, { navigation });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/operations/repository-command') {
        validateOperationRequest(request);
        const operation = repositoryCommandRequest(await jsonBody(request));
        let record;
        try {
          record = await runTypedOperation(
            'repository-command', operation.name,
            ({ signal, onStart }) => runRepositoryCommand(project, operation.name, { signal, onStart, origin: 'local-server' }),
            { cancellable: true },
          );
        }
        catch (error) {
          if (/^Unknown repository command:/.test(error.message)) error.statusCode = 400;
          throw error;
        }
        json(response, 200, {
          runId: record.id,
          status: record.status,
          operation: record.operation,
          presentation: record.presentation,
          evidence: { stdout: record.stdoutPath, stderr: record.stderrPath },
          state: await currentState(project),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/operations/terminal') {
        validateOperationRequest(request);
        if (!terminal) throw Object.assign(new Error('Terminal execution is available only in the trusted desktop application.'), { statusCode: 403 });
        const operation = terminalCommandRequest(await jsonBody(request));
        const shells = await discoverShells(project.root);
        if (!shells.find((entry) => entry.id === operation.shell)?.available) throw Object.assign(new Error(`Terminal shell is unavailable: ${operation.shell}`), { statusCode: 400 });
        const record = await runTypedOperation(
          'terminal-command', operation.command,
          ({ signal, onStart }) => runTerminalCommand(project, operation.command, { shell: operation.shell, cwd: terminalCwd, signal, onStart, origin: 'local-server' }),
          { cancellable: true },
        );
        if (record.operation?.cwdPersistence !== 'outside-repository') terminalCwd = record.operation.cwdAfter;
        json(response, 200, {
          runId: record.id, status: record.status, operation: record.operation,
          presentation: record.presentation,
          evidence: { stdout: record.stdoutPath, stderr: record.stderrPath },
          state: await currentState(project, { cwd: terminalCwd }),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/operations/undo') {
        validateOperationRequest(request);
        const operation = undoRequest(await jsonBody(request));
        let record;
        try { record = await runTypedOperation('undo', operation.runId, () => undoOperation(project, operation.runId, { origin: 'local-server' })); }
        catch (error) {
          if (/^(?:Structured operation run was not found|Undo is )/.test(error.message)) error.statusCode = 409;
          throw error;
        }
        json(response, 200, {
          runId: record.id, status: record.status, operation: record.operation,
          presentation: record.presentation,
          evidence: { stdout: record.stdoutPath, stderr: record.stderrPath },
          state: await currentState(project),
        });
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        json(response, 405, { error: 'Only typed CommandHUD operations accept local mutation requests.' });
        return;
      }
      if (url.pathname === '/state' || url.pathname === '/visual-state') {
        json(response, 200, await currentState(project));
        return;
      }
      if (url.pathname === '/runtime') {
        const shells = terminal ? await discoverShells(project.root) : [];
        json(response, 200, {
          busy: activeOperation,
          capabilities: { terminal, shells },
          terminal: terminal ? { cwd: terminalCwd, displayCwd: relative(project.root, terminalCwd).replaceAll('\\', '/') || '.' } : null,
          session: { id: project.key, connectedClients: eventClients.size, eventSequence, navigation },
        });
        return;
      }
      const activeEvidenceMatch = url.pathname.match(/^\/runtime\/evidence\/(stdout|stderr)$/i);
      if (activeEvidenceMatch) {
        const runId = url.searchParams.get('run');
        if (!activeOperation?.runId || runId !== activeOperation.runId || !activeExecution) throw Object.assign(new Error('Active run evidence is unavailable.'), { statusCode: 409 });
        const stream = activeEvidenceMatch[1].toLowerCase();
        const path = stream === 'stdout' ? activeExecution.stdoutPath : activeExecution.stderrPath;
        json(response, 200, { runId, stream, ...boundedEvidence(path, url.searchParams.get('tail') || 200) });
        return;
      }
      if (url.pathname === '/tree') {
        json(response, 200, await repositoryTree(project.root));
        return;
      }
      if (url.pathname === '/history') {
        const limit = Number(url.searchParams.get('limit') || 25);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('History limit must be an integer from 1 to 100.'), { statusCode: 400 });
        json(response, 200, { history: await operationHistory(project, limit) });
        return;
      }
      const undoMatch = url.pathname.match(/^\/undo\/(\d{14}-[0-9a-f]{4})$/i);
      if (undoMatch) {
        try { json(response, 200, await undoPlan(project, undoMatch[1])); }
        catch (error) {
          if (/^Structured operation run was not found/.test(error.message)) error.statusCode = 404;
          throw error;
        }
        return;
      }
      const historyMatch = url.pathname.match(/^\/history\/(\d{14}-[0-9a-f]{4})(\/handoff)?$/i);
      if (historyMatch) {
        const detail = await operationDetail(project, historyMatch[1]);
        if (!detail) throw Object.assign(new Error('Structured operation run was not found.'), { statusCode: 404 });
        json(response, 200, historyMatch[2] ? { runId: detail.runId, handoff: detail.handoff, metrics: detail.contextMetrics } : detail);
        return;
      }
      const evidenceMatch = url.pathname.match(/^\/history\/(\d{14}-[0-9a-f]{4})\/evidence\/(stdout|stderr)$/i);
      if (evidenceMatch) {
        json(response, 200, evidenceTail(project, evidenceMatch[1], evidenceMatch[2].toLowerCase(), url.searchParams.get('tail') || 200));
        return;
      }
      if (url.pathname === '/handoff') {
        const record = lastRun(project);
        if (!record?.operation) throw Object.assign(new Error('No structured operation is available to hand off.'), { statusCode: 404 });
        const context = await buildCurrentOperationContext(project, record);
        json(response, 200, { runId: record.id, handoff: context.handoff, metrics: context.metrics });
        return;
      }
      if (url.pathname === '/source') {
        json(response, 200, await sourceExcerpt(project, url.searchParams.get('path'), url.searchParams.get('context') ?? 2, url.searchParams.get('run')));
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
      json(response, error.statusCode || 500, { error: error.message, ...(error.busy ? { busy: error.busy } : {}) });
    }
  });
}

export async function startHudServer(project, {
  host = '127.0.0.1', port = 8765, terminal = false, onSessionClientsChanged = null,
} = {}) {
  const recovery = await recoverInterruptedRuns(project);
  if (recovery.corrupt.length) {
    const run = recovery.corrupt[0];
    throw new Error(`Interrupted evidence is corrupt for run ${run.runId}: ${run.reason} Refusing to start the operation runtime.`);
  }
  if (recovery.detached.length) {
    const run = recovery.detached[0];
    throw new Error(`A detached CommandHUD process still appears active for run ${run.runId}. Refusing to start another operation runtime.`);
  }
  const server = createHudServer(project, { terminal, onSessionClientsChanged });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  return { server, host, port: typeof address === 'object' ? address.port : port, recovery };
}
