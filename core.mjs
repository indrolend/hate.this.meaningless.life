import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const SCHEMA_VERSION = 1;

export function stateRoot(env = process.env) {
  if (env.HUD_STATE_ROOT) return resolve(env.HUD_STATE_ROOT);
  if (platform() === 'win32') return join(env.LOCALAPPDATA || homedir(), 'CommandHud');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'CommandHud');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'commandhud');
}

async function exec(command, args, cwd, { trim = true } = {}) {
  try {
    const result = await execFileAsync(command, args, { cwd, windowsHide: true, encoding: 'utf8' });
    return {
      ok: true,
      code: 0,
      stdout: trim ? result.stdout.trim() : result.stdout,
      stderr: trim ? result.stderr.trim() : result.stderr,
    };
  } catch (error) {
    return {
      ok: false,
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: trim ? String(error.stdout || '').trim() : String(error.stdout || ''),
      stderr: trim ? String(error.stderr || error.message || '').trim() : String(error.stderr || error.message || ''),
    };
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function projectStatePath(project) {
  return join(project.store, 'projects', project.key, 'state.json');
}

function emptyWorkingState() {
  return { schemaVersion: SCHEMA_VERSION, lastRunId: null, objective: null, frontier: null };
}

export function readProjectState(project) {
  return { ...emptyWorkingState(), ...(readJson(projectStatePath(project)) || {}) };
}

function writeProjectState(project, state) {
  const directory = dirname(projectStatePath(project));
  mkdirSync(directory, { recursive: true });
  writeFileSync(projectStatePath(project), `${JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);
}

function projectKey(identity) {
  return identity.id.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
}

export async function verifyRoot(candidate) {
  const requested = resolve(candidate);
  const rootResult = await exec('git', ['rev-parse', '--show-toplevel'], requested);
  if (!rootResult.ok) throw new Error(`No Git repository found from ${requested}`);
  const root = resolve(rootResult.stdout);
  const identityPath = join(root, 'distribution', 'project.json');
  const identity = readJson(identityPath);
  if (!identity?.id || identity.id !== 'indrolend/data') {
    throw new Error(`Repository at ${root} is not the verified indrolend/data project.`);
  }
  return { root, identity };
}

export async function resolveProject({ cwd = process.cwd(), root, env = process.env } = {}) {
  const store = stateRoot(env);
  if (root) return registerProject(await verifyRoot(root), store);
  try { return registerProject(await verifyRoot(cwd), store); } catch (cwdError) {
    const insideOtherRepo = await exec('git', ['rev-parse', '--show-toplevel'], cwd);
    if (insideOtherRepo.ok) throw cwdError;
    const registration = readJson(join(store, 'projects', 'indrolend_data.json'));
    if (!registration?.root) throw cwdError;
    return registerProject(await verifyRoot(registration.root), store);
  }
}

function registerProject(project, store) {
  const directory = join(store, 'projects');
  mkdirSync(directory, { recursive: true });
  const record = { schemaVersion: SCHEMA_VERSION, id: project.identity.id, root: project.root };
  writeFileSync(join(directory, `${projectKey(project.identity)}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { ...project, store, key: projectKey(project.identity) };
}

export async function gitSnapshot(root) {
  const [branch, head, upstreamRef, status] = await Promise.all([
    exec('git', ['branch', '--show-current'], root),
    exec('git', ['rev-parse', 'HEAD'], root),
    exec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root),
    exec('git', ['status', '--short'], root, { trim: false }),
  ]);
  if (!head.ok) throw new Error(`Unable to read Git authority: ${head.stderr}`);
  let upstream = null;
  let ahead = null;
  let behind = null;
  if (upstreamRef.ok) {
    const upstreamHead = await exec('git', ['rev-parse', upstreamRef.stdout], root);
    upstream = upstreamHead.ok ? upstreamHead.stdout : null;
    const counts = await exec('git', ['rev-list', '--left-right', '--count', `${upstreamRef.stdout}...HEAD`], root);
    if (counts.ok) {
      const [behindValue, aheadValue] = counts.stdout.split(/\s+/).map(Number);
      behind = behindValue;
      ahead = aheadValue;
    }
  }
  const changedFiles = status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
  return {
    branch: branch.stdout || '(detached)', head: head.stdout, upstream,
    upstreamRef: upstreamRef.ok ? upstreamRef.stdout : null,
    dirty: changedFiles.length > 0, changedFiles, ahead, behind,
  };
}

function fileKind(path) {
  const name = basename(path);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return extension || 'file';
}

function changedPathMap(statusOutput) {
  const result = new Map();
  const records = statusOutput.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3).replaceAll('\\', '/');
    result.set(path, status);
    if (status.includes('R') || status.includes('C')) index++;
  }
  return result;
}

function directoryNode(name, path = '') {
  return { name, path, directories: [], files: [] };
}

export async function repositoryTree(root) {
  const [listed, status] = await Promise.all([
    exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, { trim: false }),
    exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, { trim: false }),
  ]);
  if (!listed.ok) throw new Error(`Unable to enumerate repository tree: ${listed.stderr}`);
  if (!status.ok) throw new Error(`Unable to read repository changes: ${status.stderr}`);

  const paths = listed.stdout.split('\0').filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const changes = changedPathMap(status.stdout);
  const rootNode = directoryNode(basename(root));
  const directoryByPath = new Map([['', rootNode]]);

  for (const path of paths) {
    const parts = path.split('/');
    const name = parts.pop();
    let parentPath = '';
    for (const part of parts) {
      const childPath = parentPath ? `${parentPath}/${part}` : part;
      if (!directoryByPath.has(childPath)) {
        const child = directoryNode(part, childPath);
        directoryByPath.get(parentPath).directories.push(child);
        directoryByPath.set(childPath, child);
      }
      parentPath = childPath;
    }
    let size = null;
    try { size = statSync(join(root, ...path.split('/'))).size; } catch {}
    directoryByPath.get(parentPath).files.push({
      name,
      path,
      kind: fileKind(path),
      size,
      gitStatus: changes.get(path) || null,
    });
  }

  const sortNode = (node) => {
    node.directories.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    node.files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    node.directories.forEach(sortNode);
  };
  sortNode(rootNode);
  return {
    schemaVersion: SCHEMA_VERSION,
    root: rootNode,
    fileCount: paths.length,
    directoryCount: directoryByPath.size - 1,
  };
}

export async function repositoryCurrency(root) {
  const snapshot = await gitSnapshot(root);
  const files = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  if (!files.ok) throw new Error(`Unable to enumerate repository currency: ${files.stderr}`);
  const paths = files.stdout.split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path.replaceAll('\\', '/')); hash.update('\0');
    try { hash.update(readFileSync(join(root, path))); }
    catch (error) { hash.update(`UNREADABLE:${error.code || error.message}`); }
    hash.update('\0');
  }
  return {
    project: 'indrolend/data', root: resolve(root), head: snapshot.head,
    worktreeFingerprint: `sha256:${hash.digest('hex')}`,
  };
}

export function classifyEvidence(recordCurrency, currentCurrency) {
  if (!recordCurrency?.head || !recordCurrency?.worktreeFingerprint) return 'UNKNOWN';
  if (recordCurrency.head !== currentCurrency.head) return 'STALE';
  return recordCurrency.worktreeFingerprint === currentCurrency.worktreeFingerprint ? 'CURRENT' : 'STALE';
}

export function setWorkingValue(project, field, value, currency) {
  if (!['objective', 'frontier'].includes(field)) throw new Error(`Unsupported working state field: ${field}`);
  const state = readProjectState(project);
  state[field] = value === null ? null : {
    value, updatedAt: new Date().toISOString(), updatedByRunId: state.lastRunId || null, currency,
  };
  writeProjectState(project, state);
  return state[field];
}

export function workingValue(project, field) {
  return readProjectState(project)[field] || null;
}

function meaningfulRun(record) {
  const command = record.command || '';
  return !/^(?:(?:hud\s+)?(?:context|status|history|packet|last|tools|continue)|git\s+(?:status|rev-parse))(?:\s|$)/i.test(command);
}

export async function continuation(project, limit = 10) {
  const [git, currency] = await Promise.all([gitSnapshot(project.root), repositoryCurrency(project.root)]);
  const state = readProjectState(project);
  const runs = listRuns(project, limit).filter(meaningfulRun);
  const recentEvidence = runs.map((record) => ({
    runId: record.id, command: record.command, objective: record.objective,
    status: record.status.toUpperCase(), cause: record.reduction?.cause || null,
    classification: record.reduction?.classification || null,
    evidence: classifyEvidence(record.currencyAfter, currency),
  }));
  const lastFailure = recentEvidence.find((item) => item.status !== 'PASS') || null;
  const classifyWorking = (item) => item ? classifyEvidence(item.currency, currency) : null;
  const counts = { current: 0, stale: 0, unknown: 0 };
  for (const item of recentEvidence) counts[item.evidence.toLowerCase()]++;
  return {
    schemaVersion: SCHEMA_VERSION,
    project: { id: project.identity.id, root: project.root, branch: git.branch },
    currency: { ...currency, dirty: git.dirty, changedFiles: git.changedFiles },
    workingState: {
      objective: state.objective ? { ...state.objective, evidence: classifyWorking(state.objective) } : null,
      frontier: state.frontier ? { ...state.frontier, evidence: classifyWorking(state.frontier) } : null,
    },
    lastMeaningfulRun: recentEvidence[0] || null, lastFailure, recentEvidence, counts,
  };
}

export function discoverCommands(root) {
  const commands = [];
  const packageJson = readJson(join(root, 'package.json'));
  for (const name of Object.keys(packageJson?.scripts || {}).sort()) commands.push({ name: `npm:${name}`, command: `npm run ${name}` });
  const adapters = [
    ['assets', 'python tools/verify_asset_mirrors.py', 'tools/verify_asset_mirrors.py'],
    ['native-tests', 'node tools/run-native-tests.mjs', 'tools/run-native-tests.mjs'],
    ['multiplayer', 'npm --prefix multiplayer-server run check', 'multiplayer-server/package.json'],
    ['multiplayer-dry-deploy', 'npm --prefix multiplayer-server run deploy:dry', 'multiplayer-server/package.json'],
  ];
  for (const [name, command, owner] of adapters) if (existsSync(join(root, owner))) commands.push({ name, command });
  return commands;
}

async function versionOf(command, args = ['--version']) {
  const result = platform() === 'win32' && command === 'npm'
    ? await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], process.cwd())
    : await exec(command, args, process.cwd());
  return result.ok ? (result.stdout || result.stderr).split(/\r?\n/)[0] : 'missing';
}

export async function discoverTools() {
  const entries = await Promise.all([
    ['git', 'git'], ['node', 'node'], ['npm', 'npm'], ['cmake', 'cmake'], ['python', 'python'],
  ].map(async ([name, command]) => [name, await versionOf(command)]));
  if (platform() === 'win32') entries.push(['msbuild', await versionOf('msbuild')]);
  return Object.fromEntries(entries);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

function decodePowerShellCliXml(value) {
  const text = String(value || '');
  if (!/<Objs\b[^>]*xmlns="http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04"/i.test(text)) return text;

  const decode = (part) => part
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  const strings = [...text.matchAll(/<S(?:\s[^>]*)?>([\s\S]*?)<\/S>/gi)]
    .map((match) => decode(match[1]));

  return strings.length ? strings.join('\n') : decode(text.replace(/<[^>]+>/g, ''));
}

function normalizeTerminalText(value, root = '') {
  let text = decodePowerShellCliXml(value)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n');

  if (root) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), '.');
  }

  const input = text.split('\n');
  const output = [];
  let skipPowerShellSourceLines = 0;

  for (const line of input) {
    const trimmed = line.trim();

    if (/^At line:\d+ char:\d+$/i.test(trimmed)) {
      output.push(trimmed);
      skipPowerShellSourceLines = 2;
      continue;
    }

    if (skipPowerShellSourceLines > 0 && /^\+/.test(trimmed)) {
      skipPowerShellSourceLines--;
      continue;
    }

    if (/^\+\s*CategoryInfo\s*:/i.test(trimmed)) continue;
    if (/^\+\s*FullyQualifiedErrorId\s*:/i.test(trimmed)) continue;

    if (!trimmed && output.at(-1) === '') continue;
    output.push(line);
  }

  return output.join('\n').trim();
}

export function reduceOutput(command, stdout, stderr, exitCode, { root = '' } = {}) {
  const text = normalizeTerminalText(`${stdout}\n${stderr}`, root);
  const summary = [];
  const commandText = String(command || '');
  const testCommand = /(?:^|\s)(?:ctest|npm(?:\.cmd)?\s+(?:run\s+)?(?:test|hud:test)|node(?:\.exe)?\s+[^\r\n]*run-native-tests|verify-gameplay)/i.test(commandText);
  const auditCommand = /npm(?:\.cmd)?\s+audit/i.test(commandText);
  const assetCommand = /verify_asset_mirrors\.py|npm(?:\.cmd)?\s+(?:run\s+)?assets/i.test(commandText);
  const smokeCommand = /(?:smoke-test|desktop-smoke|room-smoke)/i.test(commandText);
  const multiplayerCommand = /multiplayer|MULTIPLAYER_PROTOCOL/i.test(commandText);
  const ctest = text.match(/(\d+)% tests passed(?:,\s*(\d+) tests failed)? out of (\d+)/i);
  if (ctest && testCommand) {
    const total = Number(ctest[3]);
    const failed = ctest[2] === undefined ? total - Math.round(total * Number(ctest[1]) / 100) : Number(ctest[2]);
    summary.push(`${total - failed}/${total} CTest`);
  }
  const nodeTests = text.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/i);
  if (nodeTests && testCommand) summary.push(`${nodeTests[2]}/${nodeTests[1]} node tests`);
  const vitest = text.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/i);
  if (vitest && testCommand) summary.push(`${vitest[1]} Vitest files, ${vitest[2]} tests`);
  if (auditCommand && /found 0 vulnerabilities/i.test(text)) summary.push('audit 0 vulnerabilities');
  if (assetCommand && /ASSET_MIRRORS=PASS/i.test(text)) summary.push('asset mirrors');
  if (smokeCommand && /SMOKE_TEST_OK/i.test(text)) summary.push('smoke test');
  if (multiplayerCommand && /MULTIPLAYER_PROTOCOL_OK/i.test(text)) summary.push('multiplayer protocol');
  const cause = exitCode === 0 ? null : firstMatch(text, [
    /[^\r\n]*(?:fatal|error|failed|exception|not found|is not recognized|cannot find)[^\r\n]*/i,
    /[^\r\n]*(?:FAIL|FAILED)[^\r\n]*/i,
  ]);
  const classification = exitCode === 0 ? null
    : /not found|not recognized|cannot find|ENOENT/i.test(cause || text) ? 'environment'
      : /test|assert|expect/i.test(cause || text) ? 'test'
        : /compile|link|cmake|msbuild/i.test(cause || text) ? 'build' : 'command';
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-8);
  return { reducer: /npm/.test(command) ? 'npm' : /ctest/.test(command) ? 'ctest' : 'generic', summary, cause, classification, tail };
}

export function buildPresentation(record) {
  const summary = Array.isArray(record.reduction?.summary) ? record.reduction.summary.filter(Boolean) : [];
  const tail = Array.isArray(record.reduction?.tail) ? record.reduction.tail.filter(Boolean) : [];
  const cause = record.reduction?.cause || null;

  let headline = null;
  const details = [];

  if (record.exitCode !== 0 && cause) {
    headline = cause;
  } else if (summary.length) {
    headline = summary[0];
    details.push(...summary.slice(1));
  } else if (tail.length) {
    headline = tail.at(-1);
  }

  return {
    status: record.status,
    request: record.request || record.objective || record.command,
    headline,
    details,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    classification: record.reduction?.classification || null,
  };
}

function createRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function buildPacket(record) {
  const status = record.status.toUpperCase();
  const change = record.gitAfter.changedFiles.length ? record.gitAfter.changedFiles.join(' | ') : 'none';
  const verify = record.reduction.summary.length ? record.reduction.summary.join('; ') : `exit ${record.exitCode}`;
  const packet = {
    STATUS: status,
    OBJECTIVE: record.objective || record.request || record.command,
    AUTHORITY: `${record.gitAfter.head} branch=${record.gitAfter.branch} dirty=${record.gitAfter.dirty}`,
    CHANGE: change,
    VERIFY: verify,
    RESULT: record.operation?.type === 'search' && record.status === 'pass'
      ? `${record.operation.matchCount} matches / ${record.operation.fileCount} files`
      : record.exitCode === 0 ? 'requested command completed' : `command exited ${record.exitCode}`,
  };
  if (record.reduction.cause) packet.CAUSE = `${record.reduction.classification}: ${record.reduction.cause}`;
  packet.FRONTIER = record.status === 'pass' ? 'select the next bounded objective' : `inspect ${record.stdoutPath} and ${record.stderrPath}`;
  return packet;
}

export function formatPacket(packet) {
  return Object.entries(packet).map(([key, value]) => `${key}=${value}`).join('\n');
}

export async function runCommand(project, tokens, {
  objective, stream = true, request = null, workflow = null,
  acceptedExitCodes = [0], operationReducer = null,
} = {}) {
  if (!tokens.length) throw new Error('hud run requires a command.');
  const command = tokens.map((token) => /[\s"']/.test(token) ? JSON.stringify(token) : token).join(' ');
  const [before, currencyBefore] = await Promise.all([gitSnapshot(project.root), repositoryCurrency(project.root)]);
  const id = createRunId();
  const runDirectory = join(project.store, 'runs', project.key, id);
  mkdirSync(dirname(runDirectory), { recursive: true });
  mkdirSync(runDirectory, { recursive: false });
  const stdoutPath = join(runDirectory, 'stdout.log');
  const stderrPath = join(runDirectory, 'stderr.log');
  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx' });
  let stdout = '';
  let stderr = '';
  const started = new Date();
  let child;
  try {
    child = spawn(command, { cwd: project.root, shell: true, windowsHide: true, env: process.env });
  } catch (error) {
    stdoutFile.end(); stderrFile.end();
    throw new Error(`Unable to spawn command: ${error.message}`);
  }
  child.stdout.on('data', (chunk) => { const value = chunk.toString(); stdout += value; stdoutFile.write(value); if (stream) process.stdout.write(value); });
  child.stderr.on('data', (chunk) => { const value = chunk.toString(); stderr += value; stderrFile.write(value); if (stream) process.stderr.write(value); });
  const exitCode = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveCode(code ?? 1));
  });
  await Promise.all([new Promise((r) => stdoutFile.end(r)), new Promise((r) => stderrFile.end(r))]);
  const ended = new Date();
  const [after, currencyAfter] = await Promise.all([gitSnapshot(project.root), repositoryCurrency(project.root)]);
  const reduction = reduceOutput(command, stdout, stderr, exitCode, { root: project.root });
  const missingCommand = exitCode !== 0 && /(?:command not found|is not recognized as (?:a name of |the name of )?a? ?(?:cmdlet|function|script file|executable program)|ENOENT)/i.test(normalizeTerminalText(`${stdout}\n${stderr}`));
  const accepted = acceptedExitCodes.includes(exitCode);
  const record = {
    schemaVersion: SCHEMA_VERSION, id, project: project.identity.id, root: project.root,
    branch: before.branch, headBefore: before.head, headAfter: after.head, upstream: before.upstream,
    request: request || null, command, argv: tokens, cwd: project.root, objective: objective || null,
    workflow: workflow ? {
      id: workflow.id || null,
      name: workflow.name || null,
      stage: workflow.stage || null,
      index: Number.isInteger(workflow.index) ? workflow.index : null,
      count: Number.isInteger(workflow.count) ? workflow.count : null,
    } : null,
    startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMs: ended - started,
    exitCode, status: accepted ? 'pass' : missingCommand ? 'blocked' : 'fail',
    dirtyBefore: before.dirty, dirtyAfter: after.dirty,
    changedFiles: after.changedFiles, gitBefore: before, gitAfter: after,
    currencyBefore, currencyAfter,
    stdoutPath, stderrPath, reducer: reduction.reducer, reduction,
  };
  if (operationReducer) record.operation = operationReducer({ stdout, stderr, exitCode, command, record });
  record.presentation = buildPresentation(record);
  record.packet = buildPacket(record);
  writeFileSync(join(runDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  const state = readProjectState(project);
  state.lastRunId = id;
  writeProjectState(project, state);
  return record;
}

export function parseSearchOutput(stdout) {
  const byPath = new Map();
  for (const row of String(stdout || '').split(/\r?\n/)) {
    if (!row) continue;
    const match = row.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;
    const path = match[1].replaceAll('\\', '/');
    const line = Number(match[2]);
    if (!Number.isInteger(line)) continue;
    if (!byPath.has(path)) byPath.set(path, { path, count: 0, lines: [] });
    const file = byPath.get(path);
    file.count++;
    file.lines.push(line);
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { matches: files.reduce((sum, file) => sum + file.count, 0), files };
}

function repositoryScope(root, requested = '.') {
  const scope = String(requested || '.').replaceAll('\\', '/').replace(/^\.\//, '') || '.';
  const target = resolve(root, ...scope.split('/'));
  const inside = relative(root, target);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Search scope is outside the verified repository: ${requested}`);
  }
  if (!existsSync(target)) throw new Error(`Search scope does not exist: ${requested}`);
  return scope;
}

export async function searchRepository(project, query, scope = '.', { stream = false, tool = 'rg' } = {}) {
  if (!String(query || '')) throw new Error('hud search requires a query.');
  const selectedScope = repositoryScope(project.root, scope);
  const availability = await exec(tool, ['--version'], project.root);
  const tokens = [tool, '-n', '--no-heading', '--color', 'never', '--fixed-strings', '--', String(query), selectedScope];
  return runCommand(project, tokens, {
    request: `search ${query} in ${selectedScope}`,
    objective: `Find ${query} in ${selectedScope}`,
    stream,
    acceptedExitCodes: [0, 1],
    operationReducer: ({ stdout, exitCode, command }) => {
      const result = exitCode <= 1 ? parseSearchOutput(stdout) : { matches: 0, files: [] };
      return {
        type: 'search', query: String(query), scope: selectedScope,
        tool, toolAvailable: availability.ok, command, exitCode,
        matchCount: result.matches, fileCount: result.files.length, files: result.files,
      };
    },
  });
}

export function buildOperationHandoff(project, record) {
  if (!record?.operation) throw new Error('The last run has no structured operation to hand off.');
  const operation = record.operation;
  const lines = [
    `REPO ${basename(project.root)}`,
    `BRANCH ${record.gitAfter?.branch || record.branch}`,
    `CWD ${operation.scope || '.'}`,
    '',
    `OPERATION ${operation.type.toUpperCase()}`,
  ];
  if (operation.type === 'search') {
    lines.push(`QUERY ${operation.query}`);
    lines.push(`COMMAND ${operation.command}`);
    lines.push(`RESULT ${operation.matchCount} matches / ${operation.fileCount} files`);
    lines.push('', 'FILES');
    for (const file of operation.files) lines.push(`${file.path} ${file.count} lines=${file.lines.join(',')}`);
  }
  lines.push('', `RAW run:${record.id}`, `STDOUT ${record.stdoutPath}`, `STDERR ${record.stderrPath}`);
  return lines.join('\n');
}

export function workflowView(project, workflowId, limit = 100) {
  const runs = listRuns(project, limit)
    .filter((run) => run.workflow?.id === workflowId)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  if (!runs.length) return null;

  const first = runs[0];
  const latest = runs.at(-1);
  const declaredCount = runs.find((run) => Number.isInteger(run.workflow?.count))?.workflow?.count ?? null;

  const latestByStage = new Map();
  const attemptsByStage = new Map();

  for (const run of runs) {
    const index = run.workflow?.index;
    const key = Number.isInteger(index) ? `stage:${index}` : `run:${run.id}`;
    latestByStage.set(key, run);
    attemptsByStage.set(key, (attemptsByStage.get(key) || 0) + 1);
  }

  const stages = [...latestByStage.entries()]
    .map(([key, run]) => ({
      runId: run.id,
      stage: run.workflow?.stage || 'unnamed',
      index: run.workflow?.index ?? null,
      count: run.workflow?.count ?? declaredCount,
      status: run.status,
      attempts: attemptsByStage.get(key) || 1,
      durationMs: run.durationMs,
      headline: run.presentation?.headline || run.reduction?.cause || null,
      startedAt: run.startedAt,
      evidenceCurrency: run.currencyAfter || null,
    }))
    .sort((a, b) => {
      const ai = Number.isInteger(a.index) ? a.index : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.index) ? b.index : Number.MAX_SAFE_INTEGER;
      return ai - bi || String(a.startedAt).localeCompare(String(b.startedAt));
    });

  const passedIndexes = new Set(
    stages
      .filter((stage) => stage.status === 'pass' && Number.isInteger(stage.index))
      .map((stage) => stage.index),
  );

  const unresolved = stages
    .filter((stage) => stage.status === 'fail' || stage.status === 'blocked')
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .at(-1) || null;

  let nextStage = null;
  if (Number.isInteger(declaredCount)) {
    for (let index = 1; index <= declaredCount; index++) {
      if (!passedIndexes.has(index)) {
        nextStage = index;
        break;
      }
    }
  }

  const pendingStages = Number.isInteger(declaredCount)
    ? Array.from({ length: declaredCount }, (_, i) => i + 1)
        .filter((index) => !stages.some((stage) => stage.index === index))
    : [];

  const completedStages = passedIndexes.size;
  const status = unresolved
    ? unresolved.status
    : Number.isInteger(declaredCount) && completedStages < declaredCount
      ? 'in_progress'
      : 'pass';

  return {
    id: workflowId,
    name: first.workflow?.name || workflowId,
    stageCount: declaredCount,
    completedStages,
    currentStage: latest.workflow?.index ?? null,
    nextStage,
    pendingStages,
    status,
    stages,
  };
}

export function buildWorkflowPacket(value) {
  const byIndex = new Map(
    value.stages
      .filter((stage) => Number.isInteger(stage.index))
      .map((stage) => [stage.index, stage]),
  );

  const lines = [
    `WORKFLOW=${value.name}`,
    `STATUS=${String(value.status).toUpperCase()}`,
  ];

  if (Number.isInteger(value.stageCount)) {
    for (let index = 1; index <= value.stageCount; index++) {
      const stage = byIndex.get(index);

      if (!stage) {
        lines.push(`STAGE_${index}=PENDING`);
        continue;
      }

      const attempts = stage.attempts > 1 ? ` attempts=${stage.attempts}` : '';
      lines.push(`STAGE_${index}=${stage.stage} ${String(stage.status).toUpperCase()}${attempts}`);
    }
  }

  const unresolved = value.stages
    .filter((stage) => stage.status === 'fail' || stage.status === 'blocked')
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .at(-1);

  if (unresolved?.headline) {
    lines.push(`CAUSE=${unresolved.headline}`);
  }

  lines.push(`CURRENT=${value.currentStage ?? 'unknown'}/${value.stageCount ?? '?'}`);

  if (value.nextStage !== null && value.nextStage !== undefined) {
    const next = byIndex.get(value.nextStage);
    lines.push(`NEXT=${value.nextStage}${next?.stage ? ` ${next.stage}` : ''}`);
  } else {
    lines.push('NEXT=none');
  }

  return lines.join('\n');
}

export async function currentState(project, { cwd = process.cwd() } = {}) {
  const [git, repository] = await Promise.all([gitSnapshot(project.root), repositoryTree(project.root)]);
  const runs = listRuns(project, 100);
  const last = runs[0] || null;
  const workflowRun = runs.find((run) => run.workflow?.id) || null;
  const workflow = workflowRun ? workflowView(project, workflowRun.workflow.id, 100) : null;
  const absoluteCwd = resolve(cwd);
  const relativeCwd = relative(project.root, absoluteCwd);
  const cwdInProject = relativeCwd === '' || (!isAbsolute(relativeCwd) && relativeCwd !== '..' && !relativeCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));

  return {
    schemaVersion: SCHEMA_VERSION,
    project: { id: project.identity.id, name: basename(project.root), root: project.root },
    cwd: { absolute: absoluteCwd, display: cwdInProject ? (relativeCwd || '.') : absoluteCwd },
    git,
    repository,
    workflow: workflow ? {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      currentStage: workflow.currentStage,
      stageCount: workflow.stageCount,
      nextStage: workflow.nextStage,
    } : null,
    last: last ? {
      runId: last.id,
      stage: last.workflow?.stage || null,
      status: last.status,
      durationMs: last.durationMs,
      headline: last.presentation?.headline || last.reduction?.cause || null,
    } : null,
    lastOperation: last?.operation || null,
    next: workflow?.nextStage ?? null,
    status: workflow?.status || last?.status || 'idle',
  };
}

export function listRuns(project, limit = 10) {
  const root = join(project.store, 'runs', project.key);
  if (!existsSync(root)) return [];
  const state = readProjectState(project);
  const ids = [];
  if (state?.lastRunId) ids.push(state.lastRunId);
  for (const id of readdirSync(root).sort().reverse()) if (!ids.includes(id)) ids.push(id);
  return ids.slice(0, limit).map((id) => readJson(join(root, id, 'run.json'))).filter(Boolean);
}

export async function fetchUpdate(project, fetchImpl = fetch) {
  const manifestUrl = project.identity.manifest;
  const response = await fetchImpl(manifestUrl, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Manifest request failed: HTTP ${response.status}`);
  const manifest = await response.json();
  if (!/^[0-9a-f]{40}$/i.test(manifest.commit || '')) throw new Error('Remote manifest has unusable commit provenance.');
  const local = await gitSnapshot(project.root);
  let status = 'current';
  if (local.head !== manifest.commit) {
    const remoteIsAncestor = await exec('git', ['merge-base', '--is-ancestor', manifest.commit, local.head], project.root);
    const localIsAncestor = await exec('git', ['merge-base', '--is-ancestor', local.head, manifest.commit], project.root);
    status = remoteIsAncestor.code === 0 ? 'local_ahead'
      : localIsAncestor.code === 0 ? 'update_available' : 'diverged';
  }
  const platformKey = platform() === 'win32' ? 'windows-x64' : platform() === 'darwin' ? 'macos-universal' : null;
  const artifact = platformKey ? manifest.artifacts?.[platformKey] : null;
  return {
    channel: project.identity.channel, localCommit: local.head, remoteCommit: manifest.commit,
    status,
    platform: platformKey || `${platform()}-unsupported`, artifact: artifact || null,
  };
}

export function lastRun(project) { return listRuns(project, 1)[0] || null; }

export function projectDigest(root) {
  return createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 12);
}
