import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
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

async function exec(command, args, cwd, { trim = true, env = process.env } = {}) {
  try {
    const result = await execFileAsync(command, args, { cwd, windowsHide: true, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
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

async function worktreeTree(root) {
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  try {
    const head = await exec('git', ['rev-parse', '--verify', 'HEAD'], root);
    const seeded = await exec('git', head.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], root, { env });
    if (!seeded.ok) throw new Error(`Unable to prepare worktree evidence: ${seeded.stderr}`);
    const added = await exec('git', ['add', '-A', '--', '.'], root, { env });
    if (!added.ok) throw new Error(`Unable to capture worktree evidence: ${added.stderr}`);
    const tree = await exec('git', ['write-tree'], root, { env });
    if (!tree.ok) throw new Error(`Unable to write worktree evidence: ${tree.stderr}`);
    return tree.stdout;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function atomicWriteJson(path, value, { exclusive = false } = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx');
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (exclusive && existsSync(path)) throw new Error(`Refusing to replace immutable JSON: ${path}`);
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
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
  atomicWriteJson(projectStatePath(project), { ...state, schemaVersion: SCHEMA_VERSION });
}

function projectKey(identity) {
  return identity.id.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
}

function inferredProjectId(root, remote) {
  const normalized = String(remote || '').trim().replace(/\\/g, '/').replace(/\.git$/i, '');
  const match = normalized.match(/(?:github\.com[/:]|\/)([^/:]+\/[^/]+)$/i);
  return match?.[1] || `local/${basename(root)}`;
}

export async function verifyRoot(candidate) {
  const requested = resolve(candidate);
  const rootResult = await exec('git', ['rev-parse', '--show-toplevel'], requested);
  if (!rootResult.ok) throw new Error(`No Git repository found from ${requested}`);
  const root = resolve(rootResult.stdout);
  const identityPaths = [
    join(root, 'commandhud.project.json'),
    join(root, '.commandhud', 'project.json'),
    join(root, 'distribution', 'project.json'),
  ];
  const identityPath = identityPaths.find((path) => existsSync(path));
  const declared = identityPath ? readJson(identityPath) : null;
  if (identityPath && (!declared?.id || typeof declared.id !== 'string')) {
    throw new Error(`CommandHUD project identity is invalid: ${identityPath}`);
  }
  const remote = await exec('git', ['config', '--get', 'remote.origin.url'], root);
  const id = declared?.id?.trim() || inferredProjectId(root, remote.ok ? remote.stdout : null);
  if (!id || /[\0\r\n]/.test(id)) throw new Error(`Repository at ${root} has an unusable project identity.`);
  return {
    root,
    identity: {
      ...(declared || {}), id,
      name: declared?.name || basename(root),
      source: identityPath ? relative(root, identityPath).replaceAll('\\', '/') : remote.ok ? 'git-remote' : 'git-root',
    },
  };
}

export async function resolveProject({ cwd = process.cwd(), root, env = process.env } = {}) {
  const store = stateRoot(env);
  if (root) return registerProject(await verifyRoot(root), store);
  return registerProject(await verifyRoot(cwd), store);
}

function registerProject(project, store) {
  const directory = join(store, 'projects');
  mkdirSync(directory, { recursive: true });
  const record = { schemaVersion: SCHEMA_VERSION, id: project.identity.id, root: project.root };
  atomicWriteJson(join(directory, `${projectKey(project.identity)}.json`), record);
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

function repositoryCommandDefinitions(root) {
  const commands = [];
  const packageJson = readJson(join(root, 'package.json'));
  for (const name of Object.keys(packageJson?.scripts || {}).sort()) commands.push({ name: `npm:${name}`, command: `npm run ${name}`, argv: ['npm', 'run', name] });
  const adapters = [
    ['assets', 'python tools/verify_asset_mirrors.py', ['python', 'tools/verify_asset_mirrors.py'], 'tools/verify_asset_mirrors.py'],
    ['native-tests', 'node tools/run-native-tests.mjs', ['node', 'tools/run-native-tests.mjs'], 'tools/run-native-tests.mjs'],
    ['multiplayer', 'npm --prefix multiplayer-server run check', ['npm', '--prefix', 'multiplayer-server', 'run', 'check'], 'multiplayer-server/package.json'],
    ['multiplayer-dry-deploy', 'npm --prefix multiplayer-server run deploy:dry', ['npm', '--prefix', 'multiplayer-server', 'run', 'deploy:dry'], 'multiplayer-server/package.json'],
  ];
  for (const [name, command, argv, owner] of adapters) if (existsSync(join(root, owner))) commands.push({ name, command, argv });
  return commands;
}

export function discoverCommands(root) {
  return repositoryCommandDefinitions(root).map(({ name, command }) => ({ name, command }));
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
  const testCommand = /(?:^|[\s"])(?:ctest|npm(?:\.cmd)?\s+(?:run\s+)?(?:test|hud:test)|node(?:\.exe)?\s+[^\r\n]*run-native-tests|verify-gameplay)/i.test(commandText);
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
  const nodeTests = text.match(/(?:#|ℹ)\s*tests (\d+)[\s\S]*?(?:#|ℹ)\s*pass (\d+)[\s\S]*?(?:#|ℹ)\s*fail (\d+)/i);
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

  if (record.status === 'interrupted') {
    headline = 'CommandHUD stopped before this operation completed.';
  } else if (record.exitCode !== 0 && cause) {
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
  const verify = record.status === 'interrupted' ? 'completion was not observed'
    : record.reduction.summary.length ? record.reduction.summary.join('; ') : `exit ${record.exitCode}`;
  const packet = {
    STATUS: status,
    OBJECTIVE: record.objective || record.request || record.command,
    AUTHORITY: `${record.gitAfter.head} branch=${record.gitAfter.branch} dirty=${record.gitAfter.dirty}`,
    CHANGE: change,
    VERIFY: verify,
    RESULT: record.status === 'interrupted' ? 'operation interrupted; inspect retained evidence and worktree changes'
      : record.operation?.type === 'search' && record.status === 'pass'
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
  acceptedExitCodes = [0], operationReducer = null, shell = true, captureDelta = false,
  signal = null, onStart = null, onOutput = null, operationIdentity = null,
  cwd = project.root, displayCommand = null,
} = {}) {
  if (!tokens.length) throw new Error('hud run requires a command.');
  const transportCommand = tokens.map((token) => /[\s"']/.test(token) ? JSON.stringify(token) : token).join(' ');
  const command = displayCommand || transportCommand;
  const [before, currencyBefore, treeBefore] = await Promise.all([
    gitSnapshot(project.root), repositoryCurrency(project.root), captureDelta ? worktreeTree(project.root) : null,
  ]);
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
  let cancellationRequested = false;
  let forceTimer = null;
  try {
    child = shell
      ? spawn(transportCommand, { cwd, shell: true, windowsHide: true, env: process.env })
      : spawn(tokens[0], tokens.slice(1), { cwd, shell: false, windowsHide: true, env: process.env });
  } catch (error) {
    stdoutFile.end(); stderrFile.end();
    throw new Error(`Unable to spawn command: ${error.message}`);
  }
  const terminate = async (force = false) => {
    if (!child?.pid || child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') await exec('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], project.root);
      else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The process may exit between the liveness check and termination request.
    }
  };
  const inflightPath = join(runDirectory, 'inflight.json');
  try {
    atomicWriteJson(inflightPath, {
      schemaVersion: SCHEMA_VERSION, id, project: project.identity.id, root: project.root,
      request: request || null, command, transportCommand, argv: tokens, cwd, objective: objective || null,
      startedAt: started.toISOString(), pid: child.pid, captureDelta, treeBefore,
      gitBefore: before, currencyBefore, stdoutPath, stderrPath, operationIdentity,
    }, { exclusive: true });
  } catch (error) {
    await terminate(true);
    stdoutFile.end(); stderrFile.end();
    throw new Error(`Unable to journal running command: ${error.message}`);
  }
  const cancel = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    void terminate(false);
    forceTimer = setTimeout(() => void terminate(true), 1500);
    forceTimer.unref?.();
  };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  onStart?.({ runId: id, command, startedAt: started.toISOString(), stdoutPath, stderrPath, pid: child.pid });
  child.stdout.on('data', (chunk) => { const value = chunk.toString(); stdout += value; stdoutFile.write(value); onOutput?.('stdout', value); if (stream) process.stdout.write(value); });
  child.stderr.on('data', (chunk) => { const value = chunk.toString(); stderr += value; stderrFile.write(value); onOutput?.('stderr', value); if (stream) process.stderr.write(value); });
  const exitCode = await new Promise((resolveCode) => {
    child.once('error', (error) => {
      const value = `${error.code || 'SPAWN'}: ${error.message}\n`;
      stderr += value;
      stderrFile.write(value);
    });
    child.once('close', (code) => resolveCode(code ?? 1));
  });
  if (forceTimer) clearTimeout(forceTimer);
  signal?.removeEventListener?.('abort', cancel);
  await Promise.all([new Promise((r) => stdoutFile.end(r)), new Promise((r) => stderrFile.end(r))]);
  const ended = new Date();
  const [after, currencyAfter, treeAfter] = await Promise.all([
    gitSnapshot(project.root), repositoryCurrency(project.root), captureDelta ? worktreeTree(project.root) : null,
  ]);
  const reduction = reduceOutput(command, stdout, stderr, exitCode, { root: project.root });
  const missingCommand = exitCode !== 0 && /(?:command not found|is not recognized as (?:a name of |the name of )?a? ?(?:cmdlet|function|script file|executable program)|ENOENT)/i.test(normalizeTerminalText(`${stdout}\n${stderr}`));
  const accepted = acceptedExitCodes.includes(exitCode);
  const record = {
    schemaVersion: SCHEMA_VERSION, id, project: project.identity.id, root: project.root,
    branch: before.branch, headBefore: before.head, headAfter: after.head, upstream: before.upstream,
    request: request || null, command, transportCommand, argv: tokens, cwd, objective: objective || null,
    workflow: workflow ? {
      id: workflow.id || null,
      name: workflow.name || null,
      stage: workflow.stage || null,
      index: Number.isInteger(workflow.index) ? workflow.index : null,
      count: Number.isInteger(workflow.count) ? workflow.count : null,
    } : null,
    startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMs: ended - started,
    exitCode, status: cancellationRequested ? 'cancelled' : accepted ? 'pass' : missingCommand ? 'blocked' : 'fail',
    dirtyBefore: before.dirty, dirtyAfter: after.dirty,
    changedFiles: after.changedFiles, gitBefore: before, gitAfter: after,
    currencyBefore, currencyAfter,
    stdoutPath, stderrPath, reducer: reduction.reducer, reduction,
  };
  if (captureDelta) {
    const patch = await exec('git', ['diff', '--binary', '--full-index', treeBefore, treeAfter], project.root, { trim: false });
    if (!patch.ok) throw new Error(`Unable to derive operation delta: ${patch.stderr}`);
    const names = await exec('git', ['diff', '--name-only', '-z', treeBefore, treeAfter], project.root, { trim: false });
    if (!names.ok) throw new Error(`Unable to list operation delta: ${names.stderr}`);
    const paths = names.stdout.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
    const patchPath = join(runDirectory, 'worktree.patch');
    if (patch.stdout) writeFileSync(patchPath, patch.stdout, { flag: 'wx' });
    record.delta = {
      kind: 'worktree-patch', treeBefore, treeAfter, paths,
      fileCount: paths.length, patchPath: patch.stdout ? patchPath : null,
    };
  }
  if (operationReducer) record.operation = operationReducer({ stdout, stderr, exitCode, command, record });
  record.presentation = buildPresentation(record);
  record.packet = buildPacket(record);
  atomicWriteJson(join(runDirectory, 'run.json'), record, { exclusive: true });
  unlinkSync(inflightPath);
  const state = readProjectState(project);
  state.lastRunId = id;
  writeProjectState(project, state);
  return record;
}

function processAppearsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function interruptedJournalProblem(project, runDirectory, id, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Journal is not valid JSON object evidence.';
  if (value.schemaVersion !== SCHEMA_VERSION) return `Unsupported journal schema: ${value.schemaVersion}`;
  if (value.id !== id || value.project !== project.identity.id || resolve(value.root || '') !== resolve(project.root)) return 'Journal identity does not match this verified project and run.';
  if (!Number.isInteger(value.pid) || value.pid <= 0) return 'Journal has no valid process identity.';
  if (typeof value.command !== 'string' || !value.command || !Array.isArray(value.argv) || value.argv.some((part) => typeof part !== 'string')) return 'Journal has no valid command identity.';
  if (!Number.isFinite(Date.parse(value.startedAt || ''))) return 'Journal has no valid start time.';
  if (!value.gitBefore?.head || !value.currencyBefore) return 'Journal is missing starting repository evidence.';
  if (value.captureDelta && !/^[0-9a-f]{40}$/i.test(value.treeBefore || '')) return 'Journal is missing its pre-operation worktree tree.';
  if (resolve(value.stdoutPath || '') !== resolve(runDirectory, 'stdout.log') || resolve(value.stderrPath || '') !== resolve(runDirectory, 'stderr.log')) return 'Journal evidence paths escape the immutable run directory.';
  return null;
}

export async function recoverInterruptedRuns(project) {
  const runsRoot = join(project.store, 'runs', project.key);
  if (!existsSync(runsRoot)) return { recovered: [], detached: [], corrupt: [] };
  const recovered = [];
  const detached = [];
  const corrupt = [];
  for (const id of readdirSync(runsRoot).sort()) {
    if (!/^\d{14}-[0-9a-f]{4}$/i.test(id)) continue;
    const runDirectory = join(runsRoot, id);
    const inflightPath = join(runDirectory, 'inflight.json');
    if (existsSync(join(runDirectory, 'run.json')) || !existsSync(inflightPath)) continue;
    const inflight = readJson(inflightPath);
    const problem = interruptedJournalProblem(project, runDirectory, id, inflight);
    if (problem) {
      corrupt.push({ runId: id, journal: inflightPath, reason: problem });
      continue;
    }
    if (processAppearsAlive(inflight.pid)) {
      detached.push({ runId: id, pid: inflight.pid, command: inflight.command, startedAt: inflight.startedAt });
      continue;
    }
    const stdout = existsSync(inflight.stdoutPath) ? readFileSync(inflight.stdoutPath, 'utf8') : '';
    const stderr = existsSync(inflight.stderrPath) ? readFileSync(inflight.stderrPath, 'utf8') : '';
    const ended = new Date();
    const [after, currencyAfter, treeAfter] = await Promise.all([
      gitSnapshot(project.root), repositoryCurrency(project.root), inflight.captureDelta ? worktreeTree(project.root) : null,
    ]);
    const reduction = reduceOutput(inflight.command, stdout, stderr, 1, { root: project.root });
    const record = {
      schemaVersion: SCHEMA_VERSION, id, project: project.identity.id, root: project.root,
      branch: inflight.gitBefore.branch, headBefore: inflight.gitBefore.head, headAfter: after.head, upstream: inflight.gitBefore.upstream,
      request: inflight.request, command: inflight.command, transportCommand: inflight.transportCommand || inflight.command,
      argv: inflight.argv, cwd: inflight.cwd || project.root, objective: inflight.objective,
      workflow: null, startedAt: inflight.startedAt, endedAt: ended.toISOString(),
      durationMs: Math.max(0, ended - new Date(inflight.startedAt)), exitCode: null, status: 'interrupted',
      dirtyBefore: inflight.gitBefore.dirty, dirtyAfter: after.dirty, changedFiles: after.changedFiles,
      gitBefore: inflight.gitBefore, gitAfter: after, currencyBefore: inflight.currencyBefore, currencyAfter,
      stdoutPath: inflight.stdoutPath, stderrPath: inflight.stderrPath, reducer: reduction.reducer, reduction,
    };
    if (inflight.captureDelta && inflight.treeBefore && treeAfter) {
      const patch = await exec('git', ['diff', '--binary', '--full-index', inflight.treeBefore, treeAfter], project.root, { trim: false });
      const names = await exec('git', ['diff', '--name-only', '-z', inflight.treeBefore, treeAfter], project.root, { trim: false });
      if (!patch.ok || !names.ok) throw new Error(`Unable to recover interrupted operation delta: ${patch.stderr || names.stderr}`);
      const paths = names.stdout.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
      const patchPath = join(runDirectory, 'worktree.patch');
      if (patch.stdout) writeFileSync(patchPath, patch.stdout, { flag: 'wx' });
      record.delta = { kind: 'worktree-patch', treeBefore: inflight.treeBefore, treeAfter, paths, fileCount: paths.length, patchPath: patch.stdout ? patchPath : null };
    }
    if (inflight.operationIdentity?.type === 'repository-command') {
      record.operation = {
        ...inflight.operationIdentity, command: inflight.command, exitCode: null,
        status: 'interrupted', durationMs: record.durationMs, summary: [...reduction.summary],
      };
    } else if (inflight.operationIdentity?.type === 'terminal-command') {
      record.operation = {
        ...inflight.operationIdentity, command: inflight.command, exitCode: null,
        status: 'interrupted', durationMs: record.durationMs,
        cwdAfter: inflight.cwd || project.root, cwdPersistence: 'unknown',
        summary: [...reduction.summary],
      };
    }
    record.presentation = buildPresentation(record);
    record.packet = buildPacket(record);
    atomicWriteJson(join(runDirectory, 'run.json'), record, { exclusive: true });
    unlinkSync(inflightPath);
    const state = readProjectState(project);
    state.lastRunId = id;
    writeProjectState(project, state);
    recovered.push(id);
  }
  return { recovered, detached, corrupt };
}

export function parseSearchOutput(stdout) {
  const byPath = new Map();
  for (const row of String(stdout || '').split(/\r?\n/)) {
    if (!row) continue;
    const match = row.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;
    const path = match[1].replaceAll('\\', '/').replace(/^\.\//, '');
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
    shell: false,
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

export async function runRepositoryCommand(project, name, { stream = false, signal = null, onStart = null, onOutput = null } = {}) {
  const selected = repositoryCommandDefinitions(project.root).find((command) => command.name === String(name || ''));
  if (!selected) throw new Error(`Unknown repository command: ${name}`);
  let argv = [...selected.argv];
  if (process.platform === 'win32' && argv[0] === 'npm') {
    if (argv.slice(1).some((argument) => !/^[A-Za-z0-9:._/-]+$/.test(argument))) {
      throw new Error(`Repository npm command has an unsupported Windows argument: ${selected.name}`);
    }
    argv = [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `npm.cmd ${argv.slice(1).join(' ')}`];
  }
  return runCommand(project, argv, {
    request: `run repository command ${selected.name}`,
    objective: `Run ${selected.command}`,
    stream,
    shell: false,
    captureDelta: true,
    signal, onStart, onOutput,
    operationIdentity: { type: 'repository-command', name: selected.name, displayCommand: selected.command },
    operationReducer: ({ exitCode, command, record }) => ({
      type: 'repository-command', name: selected.name,
      displayCommand: selected.command, command, exitCode,
      status: record.status, durationMs: record.durationMs,
      summary: [...record.reduction.summary],
    }),
  });
}

const SHELL_DEFINITIONS = {
  powershell: { label: 'PowerShell', executables: process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'] },
  bash: { label: 'Bash', executables: process.platform === 'win32' ? ['wsl.exe', 'bash.exe'] : ['bash'] },
  cmd: { label: 'Command Prompt', executables: process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe'] : [] },
};

export async function discoverShells(root = process.cwd()) {
  const shells = [];
  for (const [id, definition] of Object.entries(SHELL_DEFINITIONS)) {
    let executable = null;
    for (const candidate of definition.executables) {
      const probe = await exec(candidate, id === 'cmd' ? ['/d', '/c', 'ver'] : candidate.toLowerCase().endsWith('wsl.exe') ? ['--status'] : ['--version'], root);
      if (probe.ok) { executable = candidate; break; }
    }
    shells.push({ id, label: definition.label, available: Boolean(executable), executable });
  }
  return shells;
}

function repositoryDirectory(root, requested) {
  const target = resolve(requested || root);
  const inside = relative(root, target);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Terminal working directory is outside the verified repository: ${target}`);
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`Terminal working directory does not exist: ${target}`);
  return target;
}

export async function runTerminalCommand(project, command, {
  shell = process.platform === 'win32' ? 'powershell' : 'bash', cwd = project.root,
  stream = false, signal = null, onStart = null, onOutput = null,
} = {}) {
  const text = String(command || '');
  if (!text.trim()) throw new Error('Terminal command must not be empty.');
  if (text.length > 32 * 1024) throw new Error('Terminal command exceeds 32 KiB.');
  const selectedCwd = repositoryDirectory(project.root, cwd);
  const available = await discoverShells(project.root);
  const selected = available.find((entry) => entry.id === shell);
  if (!selected) throw new Error(`Unsupported terminal shell: ${shell}`);
  if (!selected.available) throw new Error(`Terminal shell is unavailable: ${shell}`);
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-terminal-'));
  const cwdPath = shell === 'bash' ? join(project.root, '.git', `.commandhud-cwd-${randomBytes(8).toString('hex')}.tmp`) : join(temporary, 'cwd.txt');
  let tokens;
  if (shell === 'powershell') {
    const quotedCwdPath = cwdPath.replaceAll("'", "''");
    const script = `& { ${text}\n}; $hudExit = if ($?) { 0 } elseif ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }; (Get-Location).ProviderPath | Set-Content -LiteralPath '${quotedCwdPath}' -NoNewline -Encoding utf8; exit $hudExit`;
    tokens = [selected.executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else if (shell === 'bash') {
    if (selected.executable.toLowerCase().endsWith('wsl.exe')) {
      const start = relative(project.root, selectedCwd).replaceAll('\\', '/') || '.';
      const script = `exec 3> '.git/${basename(cwdPath)}'\ncd '${start.replaceAll("'", "'\\''")}' || exit 1\n${text}\nhud_exit=$?\npwd -P >&3\nexit $hud_exit`;
      tokens = [selected.executable, '--cd', project.root, 'bash', '--noprofile', '--norc', '-c', script];
    } else {
      const start = relative(project.root, selectedCwd).replaceAll('\\', '/') || '.';
      const script = `exec 3> '.git/${basename(cwdPath)}'\ncd '${start.replaceAll("'", "'\\''")}' || exit 1\n${text}\nhud_exit=$?\npwd -W >&3\nexit $hud_exit`;
      tokens = [selected.executable, '--noprofile', '--norc', '-c', script];
    }
  } else {
    const quotedCwdPath = cwdPath.replaceAll('%', '%%').replaceAll('"', '""');
    const scriptPath = join(temporary, 'commandhud.cmd');
    writeFileSync(scriptPath, `@echo off\r\n${text}\r\nset "HUD_EXIT=%ERRORLEVEL%"\r\ncd>"${quotedCwdPath}"\r\nexit /b %HUD_EXIT%\r\n`, { flag: 'wx' });
    tokens = [selected.executable, '/d', '/q', '/v:off', '/c', scriptPath];
  }
  try {
    const record = await runCommand(project, tokens, {
      request: `terminal ${shell}`,
      objective: `Run terminal command with ${selected.label}`,
      stream, shell: false, captureDelta: true, signal, onStart, onOutput,
      cwd: selectedCwd, displayCommand: text,
      operationIdentity: { type: 'terminal-command', shell, displayCommand: text, cwdBefore: selectedCwd },
      operationReducer: ({ exitCode, record }) => {
        let cwdAfter = selectedCwd;
        let cwdPersistence = 'unchanged';
        let reportedCwd = null;
        if (existsSync(cwdPath)) {
          reportedCwd = readFileSync(cwdPath, 'utf8').replace(/^\uFEFF/, '').trim();
          if (process.platform === 'win32' && /^\/mnt\/[a-z](?:\/|$)/i.test(reportedCwd)) {
            reportedCwd = `${reportedCwd[5].toUpperCase()}:\\${reportedCwd.slice(7).replaceAll('/', '\\')}`;
          }
          try { cwdAfter = repositoryDirectory(project.root, reportedCwd); cwdPersistence = cwdAfter === selectedCwd ? 'unchanged' : 'updated'; }
          catch { cwdPersistence = 'outside-repository'; }
        }
        return {
          type: 'terminal-command', shell, shellLabel: selected.label,
          displayCommand: text, command: text, exitCode, status: record.status,
          durationMs: record.durationMs, cwdBefore: selectedCwd, cwdAfter, cwdPersistence,
          reportedCwd,
          summary: [...record.reduction.summary],
        };
      },
    });
    return record;
  } finally {
    if (shell === 'bash') rmSync(cwdPath, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function undoPlan(project, runId) {
  const record = runById(project, runId);
  if (!record?.operation) throw new Error(`Structured operation run was not found: ${runId}`);
  if (!record.delta?.patchPath || !record.delta.paths?.length || !existsSync(record.delta.patchPath)) {
    return { runId: record.id, operation: record.operation.type, state: 'NO_CHANGE', paths: [], fileCount: 0, reason: 'The recorded operation has no content-level worktree change.' };
  }
  const check = await exec('git', ['apply', '--reverse', '--check', '--binary', record.delta.patchPath], project.root);
  return {
    runId: record.id, operation: record.operation.type,
    state: check.ok ? 'SAFE' : 'CONFLICT',
    paths: [...record.delta.paths], fileCount: record.delta.paths.length,
    reason: check.ok ? 'The recorded inverse patch applies cleanly to the current worktree.' : (check.stderr || 'The current worktree no longer matches the recorded operation result.'),
  };
}

export async function undoOperation(project, runId, { stream = false } = {}) {
  const plan = await undoPlan(project, runId);
  if (plan.state !== 'SAFE') throw new Error(`Undo is ${plan.state}: ${plan.reason}`);
  const target = runById(project, runId);
  return runCommand(project, ['git', 'apply', '--reverse', '--binary', target.delta.patchPath], {
    request: `undo recorded operation ${target.id}`,
    objective: `Safely reverse ${target.operation.type} run:${target.id}`,
    stream, shell: false, captureDelta: true,
    operationReducer: ({ exitCode, command, record }) => ({
      type: 'undo', targetRunId: target.id, targetType: target.operation.type,
      command, exitCode, status: record.status, durationMs: record.durationMs,
      paths: [...plan.paths], fileCount: plan.fileCount,
    }),
  });
}

function compactContextEvidence(value, { maxLines = 40, maxChars = 6000 } = {}) {
  const cleaned = normalizeTerminalText(value || '').trim();
  if (!cleaned) return { text: '', omitted: false };
  let lines = cleaned.split('\n');
  let omitted = lines.length > maxLines;
  if (omitted) lines = lines.slice(-maxLines);
  let text = lines.join('\n');
  if (text.length > maxChars) { text = text.slice(-maxChars); omitted = true; }
  return { text, omitted };
}

function evidenceSize(path) {
  try { return path && existsSync(path) ? statSync(path).size : 0; } catch { return 0; }
}

export function buildOperationContext(project, record) {
  if (!record?.operation) throw new Error('The last run has no structured operation to hand off.');
  const operation = record.operation;
  const operationCwd = operation.cwdAfter || operation.cwdBefore || record.cwd || project.root;
  const cwdInside = relative(project.root, operationCwd).replaceAll('\\', '/');
  const lines = [
    `REPO ${basename(project.root)}`,
    `BRANCH ${record.gitAfter?.branch || record.branch}`,
    `CWD ${operation.scope || (!cwdInside || cwdInside.startsWith('..') ? '.' : cwdInside)}`,
    '',
    `OPERATION ${operation.type.toUpperCase()}`,
  ];
  if (operation.type === 'search') {
    lines.push(`QUERY ${operation.query}`);
    lines.push(`COMMAND ${operation.command}`);
    lines.push(`RESULT ${operation.matchCount} matches / ${operation.fileCount} files`);
    lines.push('', 'FILES');
    for (const file of operation.files) lines.push(`${file.path} ${file.count} lines=${file.lines.join(',')}`);
  } else if (operation.type === 'repository-command') {
    lines.push(`NAME ${operation.name}`);
    lines.push(`COMMAND ${operation.command}`);
    lines.push(operation.status === 'interrupted'
      ? `RESULT INTERRUPTED completion-not-observed duration=${operation.durationMs}ms`
      : `RESULT ${operation.status.toUpperCase()} exit=${operation.exitCode} duration=${operation.durationMs}ms`);
    if (operation.status !== 'interrupted' && operation.summary.length) lines.push(`SUMMARY ${operation.summary.join('; ')}`);
  } else if (operation.type === 'terminal-command') {
    lines.push(`SHELL ${operation.shellLabel || operation.shell}`);
    lines.push(`COMMAND ${operation.displayCommand || operation.command}`);
    lines.push(operation.status === 'interrupted'
      ? `RESULT INTERRUPTED completion-not-observed duration=${operation.durationMs}ms`
      : `RESULT ${operation.status.toUpperCase()} exit=${operation.exitCode} duration=${operation.durationMs}ms`);
    if (operation.status !== 'interrupted' && operation.summary?.length) lines.push(`SUMMARY ${operation.summary.join('; ')}`);
    if (operation.cwdPersistence === 'outside-repository') lines.push('CWD_RESULT NOT_ADOPTED outside-repository');
    if (record.delta?.paths?.length) lines.push('', 'CHANGED_FILES', ...record.delta.paths);
    const stdout = compactContextEvidence(record.stdoutPath && existsSync(record.stdoutPath) ? readFileSync(record.stdoutPath, 'utf8') : '', { maxLines: operation.summary?.length ? 12 : 40, maxChars: 6000 });
    const stderr = compactContextEvidence(record.stderrPath && existsSync(record.stderrPath) ? readFileSync(record.stderrPath, 'utf8') : '');
    if (stdout.text) lines.push('', `STDOUT_EXCERPT${stdout.omitted ? ' (tail, bounded)' : ''}`, stdout.text);
    if (stderr.text) lines.push('', `STDERR_EXCERPT${stderr.omitted ? ' (tail, bounded)' : ''}`, stderr.text);
  } else if (operation.type === 'undo') {
    lines.push(`TARGET run:${operation.targetRunId}`);
    lines.push(`COMMAND ${operation.command}`);
    lines.push(`RESULT ${operation.status.toUpperCase()} ${operation.fileCount} files duration=${operation.durationMs}ms`);
    lines.push('', 'FILES', ...operation.paths);
  } else {
    lines.push(`COMMAND ${operation.command || record.command}`);
    lines.push(`RESULT ${record.status.toUpperCase()} exit=${record.exitCode} duration=${record.durationMs}ms`);
  }
  lines.push('', `RAW run:${record.id} · inspect with /raw`);
  const handoff = lines.join('\n');
  const rawBytes = evidenceSize(record.stdoutPath) + evidenceSize(record.stderrPath);
  const contextBytes = Buffer.byteLength(handoff);
  return {
    handoff,
    metrics: {
      rawBytes, contextBytes,
      savedBytes: Math.max(0, rawBytes - contextBytes),
      reductionPercent: rawBytes > 0 ? Math.max(0, Math.round((1 - contextBytes / rawBytes) * 1000) / 10) : 0,
    },
  };
}

export function buildOperationHandoff(project, record) {
  return buildOperationContext(project, record).handoff;
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
  const requestedCwd = resolve(cwd);
  const requestedRelative = relative(project.root, requestedCwd);
  const cwdInProject = requestedRelative === '' || (!isAbsolute(requestedRelative) && requestedRelative !== '..' && !requestedRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  const absoluteCwd = cwdInProject ? requestedCwd : project.root;
  const relativeCwd = cwdInProject ? requestedRelative : '';

  return {
    schemaVersion: SCHEMA_VERSION,
    project: { id: project.identity.id, name: basename(project.root), root: project.root },
    cwd: { absolute: absoluteCwd, display: relativeCwd || '.' },
    git,
    repository,
    commands: discoverCommands(project.root),
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

export function runById(project, id) {
  const value = String(id || '');
  if (!/^\d{14}-[0-9a-f]{4}$/i.test(value)) return null;
  return readJson(join(project.store, 'runs', project.key, value, 'run.json')) || null;
}

export async function operationHistory(project, limit = 25) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 25));
  const currency = await repositoryCurrency(project.root);
  return listRuns(project, 100).filter((record) => record.operation).slice(0, bounded).map((record) => ({
    runId: record.id,
    type: record.operation.type,
    name: record.operation.name || (record.operation.type === 'undo' ? `Undo ${record.operation.targetRunId}` : null),
    query: record.operation.query || null,
    scope: record.operation.scope || '.',
    command: record.operation.command,
    status: record.status,
    durationMs: record.durationMs,
    startedAt: record.startedAt,
    evidence: classifyEvidence(record.currencyAfter, currency),
    reversible: Boolean(record.delta?.patchPath && record.delta?.paths?.length),
    result: record.status === 'interrupted' ? 'Interrupted; completion not observed'
      : record.operation.type === 'search'
      ? `${record.operation.matchCount} matches / ${record.operation.fileCount} files`
      : record.operation.type === 'undo'
        ? `${record.operation.fileCount} files restored`
        : record.operation.summary?.join('; ') || `exit ${record.exitCode}`,
  }));
}

export async function operationDetail(project, id) {
  const record = runById(project, id);
  if (!record?.operation) return null;
  const currency = await repositoryCurrency(project.root);
  const context = buildOperationContext(project, record);
  return {
    runId: record.id,
    operation: record.operation,
    status: record.status,
    durationMs: record.durationMs,
    startedAt: record.startedAt,
    evidence: classifyEvidence(record.currencyAfter, currency),
    presentation: record.presentation,
    gitBefore: record.gitBefore,
    gitAfter: record.gitAfter,
    raw: { stdout: record.stdoutPath, stderr: record.stderrPath },
    handoff: context.handoff,
    contextMetrics: context.metrics,
  };
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
