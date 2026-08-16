import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const SCHEMA_VERSION = 1;

export function stateRoot(env = process.env) {
  if (env.HUD_STATE_ROOT) return resolve(env.HUD_STATE_ROOT);
  if (platform() === 'win32') return join(env.LOCALAPPDATA || homedir(), 'CommandHud');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'CommandHud');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'commandhud');
}

async function exec(command, args, cwd) {
  try {
    const result = await execFileAsync(command, args, { cwd, windowsHide: true, encoding: 'utf8' });
    return { ok: true, code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
    };
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
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
    exec('git', ['status', '--short'], root),
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

export function reduceOutput(command, stdout, stderr, exitCode) {
  const text = `${stdout}\n${stderr}`.trim();
  const summary = [];
  const ctest = text.match(/(\d+)% tests passed(?:,\s*(\d+) tests failed)? out of (\d+)/i);
  if (ctest) {
    const total = Number(ctest[3]);
    const failed = ctest[2] === undefined ? total - Math.round(total * Number(ctest[1]) / 100) : Number(ctest[2]);
    summary.push(`${total - failed}/${total} CTest`);
  }
  const nodeTests = text.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/i);
  if (nodeTests) summary.push(`${nodeTests[2]}/${nodeTests[1]} node tests`);
  const vitest = text.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/i);
  if (vitest) summary.push(`${vitest[1]} Vitest files, ${vitest[2]} tests`);
  if (/found 0 vulnerabilities/i.test(text)) summary.push('audit 0 vulnerabilities');
  if (/ASSET_MIRRORS=PASS/i.test(text)) summary.push('asset mirrors');
  if (/SMOKE_TEST_OK/i.test(text)) summary.push('smoke test');
  if (/MULTIPLAYER_PROTOCOL_OK/i.test(text)) summary.push('multiplayer protocol');
  const cause = exitCode === 0 ? null : firstMatch(text, [
    /(?:fatal|error|failed|exception|not found|is not recognized|cannot find)[^\r\n]*/i,
    /[^\r\n]*(?:FAIL|FAILED)[^\r\n]*/i,
  ]);
  const classification = exitCode === 0 ? null
    : /not found|not recognized|cannot find|ENOENT/i.test(cause || text) ? 'environment'
      : /test|assert|expect/i.test(cause || text) ? 'test'
        : /compile|link|cmake|msbuild/i.test(cause || text) ? 'build' : 'command';
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-8);
  return { reducer: /npm/.test(command) ? 'npm' : /ctest/.test(command) ? 'ctest' : 'generic', summary, cause, classification, tail };
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
    OBJECTIVE: record.objective || record.command,
    AUTHORITY: `${record.gitAfter.head} branch=${record.gitAfter.branch} dirty=${record.gitAfter.dirty}`,
    CHANGE: change,
    VERIFY: verify,
    RESULT: record.exitCode === 0 ? 'requested command completed' : `command exited ${record.exitCode}`,
  };
  if (record.reduction.cause) packet.CAUSE = `${record.reduction.classification}: ${record.reduction.cause}`;
  packet.FRONTIER = record.exitCode === 0 ? 'select the next bounded objective' : `inspect ${record.stdoutPath} and ${record.stderrPath}`;
  return packet;
}

export function formatPacket(packet) {
  return Object.entries(packet).map(([key, value]) => `${key}=${value}`).join('\n');
}

export async function runCommand(project, tokens, { objective, stream = true } = {}) {
  if (!tokens.length) throw new Error('hud run requires a command.');
  const command = tokens.map((token) => /[\s"']/.test(token) ? JSON.stringify(token) : token).join(' ');
  const before = await gitSnapshot(project.root);
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
  const after = await gitSnapshot(project.root);
  const reduction = reduceOutput(command, stdout, stderr, exitCode);
  const missingCommand = exitCode !== 0 && /not found|not recognized|cannot find|ENOENT/i.test(`${stdout}\n${stderr}`);
  const record = {
    schemaVersion: SCHEMA_VERSION, id, project: project.identity.id, root: project.root,
    branch: before.branch, headBefore: before.head, headAfter: after.head, upstream: before.upstream,
    command, argv: tokens, cwd: project.root, objective: objective || null,
    startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMs: ended - started,
    exitCode, status: exitCode === 0 ? 'pass' : missingCommand ? 'blocked' : 'fail',
    dirtyBefore: before.dirty, dirtyAfter: after.dirty,
    changedFiles: after.changedFiles, gitBefore: before, gitAfter: after,
    stdoutPath, stderrPath, reducer: reduction.reducer, reduction,
  };
  record.packet = buildPacket(record);
  writeFileSync(join(runDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  const projectStateDirectory = join(project.store, 'projects', project.key);
  mkdirSync(projectStateDirectory, { recursive: true });
  writeFileSync(join(projectStateDirectory, 'state.json'), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, lastRunId: id }, null, 2)}\n`);
  return record;
}

export function listRuns(project, limit = 10) {
  const root = join(project.store, 'runs', project.key);
  if (!existsSync(root)) return [];
  const state = readJson(join(project.store, 'projects', project.key, 'state.json'));
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
