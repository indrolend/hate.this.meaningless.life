import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

function projectIdentityPath(root) {
  return [
    join(root, 'commandhud.project.json'),
    join(root, '.commandhud', 'project.json'),
    join(root, 'distribution', 'project.json'),
  ].find((path) => existsSync(path)) || null;
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
  const identityPath = projectIdentityPath(root);
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

export async function repositoryCurrency(root, projectId = null) {
  const [head, files] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], root),
    exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, { trim: false }),
  ]);
  if (!head.ok) throw new Error(`Unable to read repository HEAD: ${head.stderr}`);
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
    project: projectId || readJson(projectIdentityPath(root))?.id || `local/${basename(root)}`, root: resolve(root), head: head.stdout.trim(),
    worktreeFingerprint: `sha256:${hash.digest('hex')}`,
  };
}

export function classifyEvidence(recordCurrency, currentCurrency) {
  if (!recordCurrency?.head || !recordCurrency?.worktreeFingerprint) return 'UNKNOWN';
  if (recordCurrency.head !== currentCurrency.head) return 'STALE';
  return recordCurrency.worktreeFingerprint === currentCurrency.worktreeFingerprint ? 'CURRENT' : 'STALE';
}

export function classifyProofCurrency(recordCurrency, currentCurrency) {
  if (!recordCurrency?.project || !recordCurrency?.worktreeFingerprint || !currentCurrency?.project || !currentCurrency?.worktreeFingerprint) return 'UNKNOWN';
  if (recordCurrency.project !== currentCurrency.project) return 'STALE';
  return recordCurrency.worktreeFingerprint === currentCurrency.worktreeFingerprint ? 'CURRENT' : 'STALE';
}

function fileSha256(path) {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function filesystemIdentity(path, { base = process.cwd() } = {}) {
  if (typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path)) throw new Error('Filesystem identity requires a valid path.');
  const absolute = resolve(base, path);
  let metadata;
  try { metadata = statSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { path: absolute, exists: false, type: 'missing', size: null, mtime: null, sha256: null };
    throw error;
  }
  const type = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : 'other';
  return {
    path: absolute,
    exists: true,
    type,
    size: metadata.size,
    mtime: metadata.mtime.toISOString(),
    sha256: type === 'file' ? fileSha256(absolute) : null,
  };
}

export function compareFilesystemFiles(leftPath, rightPath, { base = process.cwd() } = {}) {
  const left = filesystemIdentity(leftPath, { base });
  const right = filesystemIdentity(rightPath, { base });
  let status;
  if (!left.exists && !right.exists) status = 'both-missing';
  else if (!left.exists) status = 'left-missing';
  else if (!right.exists) status = 'right-missing';
  else if (left.type !== 'file' || right.type !== 'file') status = 'not-files';
  else status = left.sha256 === right.sha256 ? 'identical' : 'different';
  return {
    status,
    sameBytes: status === 'identical' ? true : status === 'different' ? false : null,
    left,
    right,
  };
}

export function inspectRuntimeAuthority({ executingPath, project = null, env = process.env } = {}) {
  const executing = filesystemIdentity(executingPath);
  const productId = 'indrolend/hate.this.meaningless.life';
  const registeredDirectory = join(stateRoot(env), 'projects');
  const registered = existsSync(registeredDirectory)
    ? readdirSync(registeredDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJson(join(registeredDirectory, entry.name)))
      .filter((entry) => entry?.id === productId && typeof entry.root === 'string')
    : [];
  const sourceCandidates = [...new Set(registered.map((entry) => resolve(entry.root)))]
    .map((root) => ({ root, cli: filesystemIdentity(join(root, 'packages', 'commandhud', 'cli.mjs')) }))
    .filter((entry) => entry.cli.exists);
  const source = sourceCandidates.length === 1 ? sourceCandidates[0] : null;
  const sameBytes = source && executing.type === 'file' ? source.cli.sha256 === executing.sha256 : null;
  const projectCopies = project
    ? ['tools/hud/cli.mjs'].map((path) => ({ path, identity: filesystemIdentity(path, { base: project.root }) })).filter((entry) => entry.identity.exists)
    : [];
  const status = projectCopies.length || sourceCandidates.length > 1 ? 'DUPLICATE'
    : source ? (sameBytes ? 'CURRENT' : 'STALE') : 'UNKNOWN';
  return {
    status,
    productId,
    executing: { ...executing, role: executing.path.includes(`${join('node_modules', '@indrolend', 'hate-this-meaningless-life')}`) ? 'installed' : 'source' },
    source,
    sameBytes,
    sourceCandidates,
    project: project ? { id: project.identity.id, root: project.root } : null,
    projectCopies,
  };
}

export async function recordFilesystemComparison(project, leftPath, rightPath, { stream = false, origin = 'core-api' } = {}) {
  if (typeof leftPath !== 'string' || typeof rightPath !== 'string') throw new Error('hud compare-files requires two filesystem paths.');
  const moduleUrl = new URL('./core.mjs', import.meta.url).href;
  const script = `import { compareFilesystemFiles } from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(compareFilesystemFiles(process.argv[1],process.argv[2],{base:process.argv[3]})))`;
  return runCommand(project, [process.execPath, '--input-type=module', '-e', script, leftPath, rightPath, project.root], {
    request: `compare filesystem bytes ${leftPath} and ${rightPath}`,
    objective: 'Record byte-level source/runtime identity comparison',
    stream,
    origin,
    shell: false,
    operationIdentity: { type: 'filesystem-comparison' },
    operationReducer: ({ stdout, command, record }) => {
      let comparison = null;
      if (record.exitCode === 0) {
        try { comparison = JSON.parse(String(stdout || '').trim()); }
        catch { throw new Error('Filesystem comparison probe did not return valid JSON evidence.'); }
      }
      return {
        type: 'filesystem-comparison', command,
        displayCommand: `compare-files ${leftPath} ${rightPath}`,
        status: record.status, exitCode: record.exitCode, durationMs: record.durationMs, comparison,
      };
    },
  });
}

export function parseWindowsServiceObservation(stdout) {
  let value;
  try { value = JSON.parse(String(stdout || '').trim()); }
  catch { throw new Error('Windows service probe did not return valid JSON evidence.'); }
  const validText = (item) => typeof item === 'string' && item.length > 0 && !/[\0\r\n]/.test(item);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validText(value.name) || !validText(value.status) ||
      !Array.isArray(value.dependsOn) || !Array.isArray(value.dependents) ||
      value.dependsOn.some((item) => !validText(item)) || value.dependents.some((item) => !validText(item)) ||
      !Number.isInteger(value.processId) || value.processId < 0 || typeof value.canStop !== 'boolean') {
    throw new Error('Windows service probe returned malformed evidence.');
  }
  return {
    name: value.name,
    displayName: validText(value.displayName) ? value.displayName : value.name,
    status: value.status,
    startType: validText(value.startType) ? value.startType : 'Unknown',
    canStop: value.canStop,
    processId: value.processId,
    dependsOn: [...new Set(value.dependsOn)].sort((a, b) => a.localeCompare(b, 'en')),
    dependents: [...new Set(value.dependents)].sort((a, b) => a.localeCompare(b, 'en')),
  };
}

export function buildWindowsServiceResetPlan(observations, targetName) {
  if (!Array.isArray(observations) || !observations.length) throw new Error('Windows service reset plan requires observed services.');
  const byName = new Map(observations.map((item) => {
    const parsed = parseWindowsServiceObservation(JSON.stringify(item));
    return [parsed.name.toLowerCase(), parsed];
  }));
  const target = byName.get(String(targetName || '').toLowerCase());
  if (!target) throw new Error(`Windows service reset plan is missing target ${targetName}.`);
  const visited = new Set();
  const active = new Set();
  const missing = new Set();
  const stop = [];
  const visit = (service) => {
    const key = service.name.toLowerCase();
    if (active.has(key)) throw new Error(`Windows service dependency cycle includes ${service.name}.`);
    if (visited.has(key)) return;
    active.add(key);
    for (const name of service.dependents) {
      const dependent = byName.get(name.toLowerCase());
      if (dependent) visit(dependent);
      else missing.add(name);
    }
    active.delete(key);
    visited.add(key);
    if (service.status.toLowerCase() === 'running') stop.push(service.name);
  };
  visit(target);
  const blockers = [...visited].flatMap((key) => {
    const item = byName.get(key);
    const status = item.status.toLowerCase();
    return (status === 'running' && !item.canStop) || (status !== 'running' && status !== 'stopped') ? [item.name] : [];
  });
  const start = [...stop].reverse();
  if (!start.some((name) => name.toLowerCase() === target.name.toLowerCase())) start.unshift(target.name);
  return {
    target: target.name,
    safe: blockers.length === 0 && missing.size === 0,
    blockers,
    missing: [...missing].sort((a, b) => a.localeCompare(b, 'en')),
    stop,
    start,
    observed: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

function windowsServiceName(name, command) {
  const service = String(name || '');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(service)) throw new Error(`hud ${command} requires a valid Windows service name.`);
  if (process.platform !== 'win32') throw new Error('Windows service observation is available only on Windows.');
  return service;
}

async function windowsPowerShell(root) {
  return (await exec('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], root)).ok
    ? 'pwsh.exe' : 'powershell.exe';
}

export async function observeWindowsService(project, name, { stream = false, origin = 'core-api' } = {}) {
  const service = windowsServiceName(name, 'service');
  const shell = await windowsPowerShell(project.root);
  const script = [
    "$ErrorActionPreference='Stop';",
    `$service=Get-Service -Name '${service}';`,
    `$cim=Get-CimInstance Win32_Service -Filter \"Name='${service}'\";`,
    '[pscustomobject]@{',
    'name=$service.Name;displayName=$service.DisplayName;status=[string]$service.Status;startType=[string]$service.StartType;',
    'canStop=[bool]$service.CanStop;processId=[int]$cim.ProcessId;',
    'dependsOn=@($service.ServicesDependedOn|ForEach-Object Name);dependents=@($service.DependentServices|ForEach-Object Name)',
    '}|ConvertTo-Json -Compress',
  ].join('');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runCommand(project, [shell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    request: `observe Windows service ${service}`,
    objective: `Record factual Windows service state for ${service}`,
    stream,
    origin,
    shell: false,
    operationIdentity: { type: 'windows-service-observation', name: service },
    operationReducer: ({ stdout, command, record }) => ({
      type: 'windows-service-observation', name: service, command,
      displayCommand: `Get-Service -Name ${service}; Get-CimInstance Win32_Service`,
      status: record.status, exitCode: record.exitCode, durationMs: record.durationMs,
      observation: record.exitCode === 0 ? parseWindowsServiceObservation(stdout) : null,
    }),
  });
}

export async function planWindowsServiceReset(project, name, { stream = false, origin = 'core-api' } = {}) {
  const service = windowsServiceName(name, 'service-reset-plan');
  const shell = await windowsPowerShell(project.root);
  const script = [
    "$ErrorActionPreference='Stop';",
    '$items=[System.Collections.Generic.List[object]]::new();$seen=@{};',
    'function Add-ServiceTree($service){',
    'if($seen.ContainsKey($service.Name)){return};$seen[$service.Name]=$true;',
    `$cim=Get-CimInstance Win32_Service -Filter \"Name='$($service.Name)'\";`,
    '$items.Add([pscustomobject]@{name=$service.Name;displayName=$service.DisplayName;status=[string]$service.Status;',
    'startType=[string]$service.StartType;canStop=[bool]$service.CanStop;processId=[int]$cim.ProcessId;',
    'dependsOn=@($service.ServicesDependedOn|ForEach-Object Name);dependents=@($service.DependentServices|ForEach-Object Name)});',
    'foreach($dependent in $service.DependentServices){Add-ServiceTree $dependent}};',
    `Add-ServiceTree (Get-Service -Name '${service}');`,
    'ConvertTo-Json -InputObject @($items) -Compress -Depth 4',
  ].join('');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runCommand(project, [shell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    request: `plan Windows service reset ${service}`,
    objective: `Observe dependencies and plan a safe reset for ${service}`,
    stream,
    origin,
    shell: false,
    operationIdentity: { type: 'windows-service-reset-plan', name: service },
    operationReducer: ({ stdout, command, record }) => {
      let plan = null;
      if (record.exitCode === 0) {
        let observations;
        try { observations = JSON.parse(String(stdout || '').trim()); }
        catch { throw new Error('Windows service reset probe did not return valid JSON evidence.'); }
        plan = buildWindowsServiceResetPlan(observations, service);
      }
      return {
        type: 'windows-service-reset-plan', name: service, command,
        displayCommand: `Get-Service -Name ${service}; recursively inspect dependent services`,
        status: record.status, exitCode: record.exitCode, durationMs: record.durationMs, plan,
      };
    },
  });
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
  const [git, currency] = await Promise.all([gitSnapshot(project.root), repositoryCurrency(project.root, project.identity.id)]);
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
  const identityPath = projectIdentityPath(root);
  const configured = identityPath ? readJson(identityPath)?.commandHud?.commands : null;
  if (configured !== null && configured !== undefined && !Array.isArray(configured)) {
    throw new Error('commandHud.commands must be an array.');
  }
  for (const entry of configured || []) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const command = typeof entry?.command === 'string' ? entry.command.trim() : '';
    const argv = entry?.argv;
    const owner = typeof entry?.owner === 'string' ? entry.owner.replaceAll('\\', '/') : null;
    const successMarkers = entry?.successMarkers || [];
    const resultMarkers = entry?.resultMarkers ?? false;
    const kind = entry?.kind || null;
    if (!/^[a-z0-9][a-z0-9:._-]*$/i.test(name) || !command || !Array.isArray(argv) || !argv.length || argv.some((value) => typeof value !== 'string' || !value)) {
      throw new Error(`Invalid CommandHUD command declaration: ${name || '(unnamed)'}`);
    }
    if (!Array.isArray(successMarkers) || successMarkers.some((marker) =>
      typeof marker?.contains !== 'string' || !marker.contains || marker.contains.length > 200 ||
      typeof marker?.summary !== 'string' || !marker.summary || marker.summary.length > 120)) {
      throw new Error(`Invalid CommandHUD success marker declaration: ${name}`);
    }
    if (typeof resultMarkers !== 'boolean') throw new Error(`Invalid CommandHUD result marker declaration: ${name}`);
    if (kind !== null && !['test', 'audit', 'smoke', 'lint'].includes(kind)) throw new Error(`Invalid CommandHUD command kind: ${name}`);
    if (owner) {
      const ownerPath = resolve(root, owner);
      const ownerRelative = relative(root, ownerPath);
      if (isAbsolute(ownerRelative) || ownerRelative === '..' || ownerRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error(`CommandHUD command owner escapes the repository: ${owner}`);
      }
      if (!existsSync(ownerPath)) continue;
    }
    if (commands.some((item) => item.name === name)) throw new Error(`Duplicate repository command identity: ${name}`);
    commands.push({ name, command, argv: [...argv], kind, resultMarkers, successMarkers: successMarkers.map((marker) => ({ contains: marker.contains, summary: marker.summary })) });
  }
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

export function parseResultMarkers(stdout, stderr = '') {
  const markers = [];
  for (const [stream, content] of [['stdout', stdout], ['stderr', stderr]]) {
    const lines = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      const match = line.match(/^([A-Z][A-Z0-9_]{1,63})=(PASS|FAIL)(?:\s+(.*))?$/);
      if (!match) continue;
      const fields = {};
      let valid = true;
      for (const token of match[3]?.split(/\s+/).filter(Boolean) || []) {
        const field = token.match(/^([A-Za-z][A-Za-z0-9_.-]{0,63})=([^\s=]+)$/);
        if (!field || Object.hasOwn(fields, field[1])) { valid = false; break; }
        fields[field[1]] = field[2];
      }
      if (valid) markers.push({ event: match[1], status: match[2], fields, stream, line: index + 1, raw: line });
    }
  }
  return markers;
}

export function parseLintDiagnostics(stdout, stderr = '', root = process.cwd()) {
  const diagnostics = [];
  const seen = new Set();
  for (const content of [stdout, stderr]) {
    for (const raw of normalizeTerminalText(String(content || ''), root).split(/\r?\n/)) {
      const line = raw.trim();
      const typescript = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.+)$/i);
      const standard = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s*:?[ \t]*(.+?)(?:\s+\[([^\]]+)\])?$/i);
      const match = typescript || standard;
      if (!match) continue;
      const rawPath = match[1].replaceAll('\\', '/');
      const absolute = resolve(root, rawPath);
      const inside = relative(root, absolute);
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(absolute)) continue;
      const diagnostic = typescript ? {
        path: inside.replaceAll('\\', '/'), line: Number(match[2]), column: Number(match[3]),
        severity: match[4].toLowerCase(), code: match[5], message: match[6],
      } : {
        path: inside.replaceAll('\\', '/'), line: Number(match[2]), column: Number(match[3]),
        severity: match[4].toLowerCase(), code: match[6] || null, message: match[5],
      };
      const key = JSON.stringify(diagnostic);
      if (!seen.has(key)) { seen.add(key); diagnostics.push(diagnostic); }
    }
  }
  return diagnostics.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.line - b.line || a.column - b.column || a.message.localeCompare(b.message, 'en'));
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

export function reduceOutput(command, stdout, stderr, exitCode, { root = '', kind = null, successMarkers = [], resultMarkers = false } = {}) {
  const text = normalizeTerminalText(`${stdout}\n${stderr}`, root);
  const summary = [];
  const commandText = String(command || '');
  const testCommand = kind === 'test' || /(?:^|[\s"])(?:ctest|npm(?:\.cmd)?\s+(?:run\s+)?(?:test|hud:test))/i.test(commandText);
  const auditCommand = kind === 'audit' || /npm(?:\.cmd)?\s+audit/i.test(commandText);
  const smokeCommand = kind === 'smoke' || /(?:smoke-test|desktop-smoke|room-smoke)/i.test(commandText);
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
  if (smokeCommand && /SMOKE_TEST_OK/i.test(text)) summary.push('smoke test');
  if (exitCode === 0) {
    for (const marker of successMarkers) if (text.includes(marker.contains) && !summary.includes(marker.summary)) summary.push(marker.summary);
  }
  const cause = exitCode === 0 ? null : firstMatch(text, [
    /[^\r\n]*(?:fatal|error|failed|exception|not found|is not recognized|cannot find)[^\r\n]*/i,
    /[^\r\n]*(?:FAIL|FAILED)[^\r\n]*/i,
  ]);
  const classification = exitCode === 0 ? null
    : /not found|not recognized|cannot find|ENOENT/i.test(cause || text) ? 'environment'
      : /test|assert|expect/i.test(cause || text) ? 'test'
        : /compile|link|cmake|msbuild/i.test(cause || text) ? 'build' : 'command';
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-8);
  const markers = resultMarkers ? parseResultMarkers(stdout, stderr) : [];
  return { reducer: /npm/.test(command) ? 'npm' : /ctest/.test(command) ? 'ctest' : 'generic', summary, cause, classification, tail, markers };
}

export function classifyPowerShellShellFailure(stderr) {
  const text = normalizeTerminalText(String(stderr || ''));
  const commandNotFound = firstMatch(text, [
    /[^\r\n]*The term '[^']+' is not recognized as a name of a cmdlet, function, script file, or executable program[^\r\n]*/i,
    /[^\r\n]*CommandNotFoundException[^\r\n]*/i,
  ]);
  if (commandNotFound) return { kind: 'command-not-found', classification: 'environment', message: commandNotFound };
  return null;
}

export function buildPresentation(record) {
  const summary = Array.isArray(record.reduction?.summary) ? record.reduction.summary.filter(Boolean) : [];
  const tail = Array.isArray(record.reduction?.tail) ? record.reduction.tail.filter(Boolean) : [];
  const cause = record.reduction?.cause || null;

  let headline = null;
  const details = [];

  if (record.status === 'interrupted') {
    headline = 'CommandHUD stopped before this operation completed.';
  } else if (cause) {
    headline = cause;
  } else if (summary.length) {
    headline = summary[0];
    details.push(...summary.slice(1));
  } else if (tail.length) {
    headline = tail.at(-1);
  }

  return {
    status: record.status,
    provenance: record.provenance || { origin: 'legacy-unknown', finalizedBy: 'unknown' },
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
  cwd = project.root, displayCommand = null, reductionKind = null, successMarkers = [], resultMarkers = false,
  origin = 'core-api', classifyCapturedFailure = null,
} = {}) {
  if (!tokens.length) throw new Error('hud run requires a command.');
  const origins = new Set(['core-api', 'cli-argv', 'terminal-ui', 'local-server']);
  if (!origins.has(origin)) throw new Error(`Unsupported operation origin: ${origin}`);
  const transportCommand = tokens.map((token) => /[\s"']/.test(token) ? JSON.stringify(token) : token).join(' ');
  const command = displayCommand || transportCommand;
  const [before, currencyBefore, treeBefore] = await Promise.all([
    gitSnapshot(project.root), repositoryCurrency(project.root, project.identity.id), captureDelta ? worktreeTree(project.root) : null,
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
      gitBefore: before, currencyBefore, stdoutPath, stderrPath, operationIdentity, resultMarkers,
      provenance: { origin },
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
    gitSnapshot(project.root), repositoryCurrency(project.root, project.identity.id), captureDelta ? worktreeTree(project.root) : null,
  ]);
  const reduction = reduceOutput(command, stdout, stderr, exitCode, { root: project.root, kind: reductionKind, successMarkers, resultMarkers });
  const capturedFailure = classifyCapturedFailure?.({ stdout, stderr, exitCode }) || null;
  if (capturedFailure) {
    reduction.cause ||= capturedFailure.message || 'The shell reported that the requested operation failed.';
    reduction.classification ||= capturedFailure.classification || 'command';
  }
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
    exitCode, status: cancellationRequested ? 'cancelled' : capturedFailure ? 'fail' : accepted ? 'pass' : missingCommand ? 'blocked' : 'fail',
    capturedFailure,
    dirtyBefore: before.dirty, dirtyAfter: after.dirty,
    changedFiles: after.changedFiles, gitBefore: before, gitAfter: after,
    currencyBefore, currencyAfter,
    stdoutPath, stderrPath, reducer: reduction.reducer, reduction,
    provenance: { origin, finalizedBy: 'process-exit' },
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
  if (operationReducer) {
    record.operation = operationReducer({ stdout, stderr, exitCode, command, record });
    record.operation.provenance = record.provenance;
  }
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
      gitSnapshot(project.root), repositoryCurrency(project.root, project.identity.id), inflight.captureDelta ? worktreeTree(project.root) : null,
    ]);
    const reduction = reduceOutput(inflight.command, stdout, stderr, 1, { root: project.root, resultMarkers: inflight.resultMarkers === true });
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
      provenance: { origin: inflight.provenance?.origin || 'legacy-unknown', finalizedBy: 'startup-recovery' },
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
    if (inflight.operationIdentity?.type === 'repository-command' || inflight.operationIdentity?.type === 'lint') {
      record.operation = {
        ...inflight.operationIdentity, command: inflight.command, exitCode: null,
        status: 'interrupted', durationMs: record.durationMs, summary: [...reduction.summary], markers: [...reduction.markers],
      };
      if (inflight.operationIdentity.type === 'lint') Object.assign(record.operation, { diagnosticCount: 0, fileCount: 0, files: [], diagnostics: [] });
    } else if (inflight.operationIdentity?.type === 'terminal-command') {
      record.operation = {
        ...inflight.operationIdentity, command: inflight.command, exitCode: null,
        status: 'interrupted', durationMs: record.durationMs,
        cwdAfter: inflight.cwd || project.root, cwdPersistence: 'unknown',
        summary: [...reduction.summary],
      };
    }
    if (record.operation) record.operation.provenance = record.provenance;
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

export async function searchRepository(project, query, scope = '.', { stream = false, tool = 'rg', origin = 'core-api' } = {}) {
  if (!String(query || '')) throw new Error('hud search requires a query.');
  const selectedScope = repositoryScope(project.root, scope);
  const availability = await exec(tool, ['--version'], project.root);
  const tokens = [tool, '-n', '--no-heading', '--color', 'never', '--fixed-strings', '--', String(query), selectedScope];
  return runCommand(project, tokens, {
    request: `search ${query} in ${selectedScope}`,
    objective: `Find ${query} in ${selectedScope}`,
    stream,
    shell: false,
    origin,
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

function repositoryCommandArgv(selected) {
  let argv = [...selected.argv];
  if (process.platform === 'win32' && argv[0] === 'npm') {
    if (argv.slice(1).some((argument) => !/^[A-Za-z0-9:._/-]+$/.test(argument))) {
      throw new Error(`Repository npm command has an unsupported Windows argument: ${selected.name}`);
    }
    argv = [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `npm.cmd ${argv.slice(1).join(' ')}`];
  }
  return argv;
}

export async function runRepositoryCommand(project, name, { stream = false, signal = null, onStart = null, onOutput = null, origin = 'core-api' } = {}) {
  const selected = repositoryCommandDefinitions(project.root).find((command) => command.name === String(name || ''));
  if (!selected) throw new Error(`Unknown repository command: ${name}`);
  const argv = repositoryCommandArgv(selected);
  return runCommand(project, argv, {
    request: `run repository command ${selected.name}`,
    objective: `Run ${selected.command}`,
    stream,
    origin,
    shell: false,
    captureDelta: true,
    reductionKind: selected.kind,
    successMarkers: selected.successMarkers,
    resultMarkers: selected.resultMarkers,
    signal, onStart, onOutput,
    operationIdentity: { type: 'repository-command', name: selected.name, displayCommand: selected.command },
    operationReducer: ({ exitCode, command, record }) => ({
      type: 'repository-command', name: selected.name,
      displayCommand: selected.command, command, exitCode,
      status: record.status, durationMs: record.durationMs,
      summary: [...record.reduction.summary],
      markers: [...record.reduction.markers],
    }),
  });
}

export async function lintRepository(project, { stream = false, signal = null, onStart = null, onOutput = null, origin = 'core-api' } = {}) {
  const commands = repositoryCommandDefinitions(project.root);
  const selected = commands.find((command) => command.name === 'lint') || commands.find((command) => command.name === 'npm:lint');
  if (!selected) throw new Error('This repository does not declare a lint command.');
  const argv = repositoryCommandArgv(selected);
  return runCommand(project, argv, {
    request: 'lint repository', objective: `Lint with ${selected.command}`,
    stream, origin, shell: false, captureDelta: true, reductionKind: 'lint',
    successMarkers: selected.successMarkers, resultMarkers: selected.resultMarkers,
    signal, onStart, onOutput,
    operationIdentity: { type: 'lint', authority: selected.name, displayCommand: selected.command },
    operationReducer: ({ stdout, stderr, exitCode, command, record }) => {
      const diagnostics = parseLintDiagnostics(stdout, stderr, project.root);
      const files = [...new Set(diagnostics.map((diagnostic) => diagnostic.path))].sort((a, b) => a.localeCompare(b, 'en'));
      return {
        type: 'lint', authority: selected.name, displayCommand: selected.command, command, exitCode,
        status: record.status, durationMs: record.durationMs,
        diagnosticCount: diagnostics.length, fileCount: files.length, files, diagnostics,
        summary: [...record.reduction.summary], markers: [...record.reduction.markers],
      };
    },
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
  stream = false, signal = null, onStart = null, onOutput = null, origin = 'core-api',
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
    const script = `$global:LASTEXITCODE = 0; & { ${text}\n}; $hudSucceeded = $?; $hudNativeExit = $LASTEXITCODE; $hudExit = if ($hudNativeExit -is [int] -and $hudNativeExit -ne 0) { $hudNativeExit } elseif ($hudSucceeded) { 0 } else { 1 }; (Get-Location).ProviderPath | Set-Content -LiteralPath '${quotedCwdPath}' -NoNewline -Encoding utf8; exit $hudExit`;
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
      origin,
      cwd: selectedCwd, displayCommand: text,
      classifyCapturedFailure: shell === 'powershell' ? ({ stderr }) => classifyPowerShellShellFailure(stderr) : null,
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

export async function undoOperation(project, runId, { stream = false, origin = 'core-api' } = {}) {
  const plan = await undoPlan(project, runId);
  if (plan.state !== 'SAFE') throw new Error(`Undo is ${plan.state}: ${plan.reason}`);
  const target = runById(project, runId);
  return runCommand(project, ['git', 'apply', '--reverse', '--binary', target.delta.patchPath], {
    request: `undo recorded operation ${target.id}`,
    objective: `Safely reverse ${target.operation.type} run:${target.id}`,
    stream, shell: false, captureDelta: true,
    origin,
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

export function buildOperationContext(project, record, { currentCurrency = null } = {}) {
  if (!record?.operation) throw new Error('The last run has no structured operation to hand off.');
  const operation = record.operation;
  const operationCwd = operation.cwdAfter || operation.cwdBefore || record.cwd || project.root;
  const cwdInside = relative(project.root, operationCwd).replaceAll('\\', '/');
  const lines = [
    `REPO ${basename(project.root)}`,
    `BRANCH ${record.gitAfter?.branch || record.branch}`,
    `CWD ${operation.scope || (!cwdInside || cwdInside.startsWith('..') ? '.' : cwdInside)}`,
  ];
  lines.push(`ORIGIN ${record.provenance?.origin || 'legacy-unknown'}`);
  if (currentCurrency) {
    const evidence = classifyEvidence(record.currencyAfter, currentCurrency);
    lines.push(`EVIDENCE ${evidence}`);
    if (evidence === 'STALE') {
      lines.push(`RUN_HEAD ${record.currencyAfter?.head || 'unknown'}`);
      lines.push(`CURRENT_HEAD ${currentCurrency.head}`);
    }
  }
  lines.push('', `OPERATION ${operation.type.toUpperCase()}`);
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
    for (const marker of operation.markers || []) {
      const fields = Object.entries(marker.fields).map(([key, value]) => `${key}=${value}`).join(' ');
      lines.push(`MARKER ${marker.event}=${marker.status}${fields ? ` ${fields}` : ''}`);
    }
  } else if (operation.type === 'lint') {
    lines.push(`AUTHORITY ${operation.authority}`);
    lines.push(`COMMAND ${operation.displayCommand || operation.command}`);
    lines.push(operation.status === 'interrupted'
      ? `RESULT INTERRUPTED completion-not-observed duration=${operation.durationMs}ms`
      : `RESULT ${operation.status.toUpperCase()} exit=${operation.exitCode} diagnostics=${operation.diagnosticCount} files=${operation.fileCount} duration=${operation.durationMs}ms`);
    for (const marker of operation.markers || []) {
      const fields = Object.entries(marker.fields).map(([key, value]) => `${key}=${value}`).join(' ');
      lines.push(`MARKER ${marker.event}=${marker.status}${fields ? ` ${fields}` : ''}`);
    }
    if (operation.diagnostics.length) {
      lines.push('', 'DIAGNOSTICS');
      for (const diagnostic of operation.diagnostics.slice(0, 100)) {
        lines.push(`${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${diagnostic.code ? ` ${diagnostic.code}` : ''} ${diagnostic.message}`);
      }
      if (operation.diagnostics.length > 100) lines.push(`... ${operation.diagnostics.length - 100} additional diagnostics retained in raw evidence`);
    }
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
  } else if (operation.type === 'windows-service-observation') {
    lines.push(`SERVICE ${operation.name}`);
    lines.push(`COMMAND ${operation.displayCommand}`);
    lines.push('TRANSPORT runtime-owned encoded PowerShell; exact argv retained in run record');
    lines.push(`RESULT ${operation.status.toUpperCase()} exit=${operation.exitCode} duration=${operation.durationMs}ms`);
    if (operation.observation) {
      lines.push(`STATE ${operation.observation.status}`);
      lines.push(`START_TYPE ${operation.observation.startType}`);
      lines.push(`PROCESS_ID ${operation.observation.processId}`);
      lines.push(`CAN_STOP ${operation.observation.canStop}`);
      lines.push(`DEPENDS_ON ${operation.observation.dependsOn.join(',') || 'none'}`);
      lines.push(`DEPENDENTS ${operation.observation.dependents.join(',') || 'none'}`);
    }
  } else if (operation.type === 'windows-service-reset-plan') {
    lines.push(`SERVICE ${operation.name}`);
    lines.push(`COMMAND ${operation.displayCommand}`);
    lines.push('ACTION PLAN_ONLY no service state changed');
    lines.push(`RESULT ${operation.status.toUpperCase()} exit=${operation.exitCode} duration=${operation.durationMs}ms`);
    if (operation.plan) {
      lines.push(`SAFE ${operation.plan.safe}`);
      lines.push(`BLOCKERS ${operation.plan.blockers.join(',') || 'none'}`);
      lines.push(`MISSING ${operation.plan.missing.join(',') || 'none'}`);
      lines.push(`STOP_ORDER ${operation.plan.stop.join(' -> ') || 'none'}`);
      lines.push(`START_ORDER ${operation.plan.start.join(' -> ') || 'none'}`);
    }
  } else if (operation.type === 'filesystem-comparison') {
    lines.push(`COMMAND ${operation.displayCommand}`);
    lines.push(`RESULT ${operation.status.toUpperCase()} exit=${operation.exitCode} duration=${operation.durationMs}ms`);
    if (operation.comparison) {
      lines.push(`BYTE_STATUS ${operation.comparison.status}`);
      lines.push(`SAME_BYTES ${operation.comparison.sameBytes}`);
      lines.push(`LEFT ${operation.comparison.left.path}`);
      lines.push(`LEFT_SHA256 ${operation.comparison.left.sha256 || 'none'}`);
      lines.push(`RIGHT ${operation.comparison.right.path}`);
      lines.push(`RIGHT_SHA256 ${operation.comparison.right.sha256 || 'none'}`);
    }
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

export async function buildCurrentOperationContext(project, record) {
  return buildOperationContext(project, record, {
    currentCurrency: await repositoryCurrency(project.root, project.identity.id),
  });
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

function runIdsNewest(project) {
  const root = join(project.store, 'runs', project.key);
  if (!existsSync(root)) return { root, ids: [] };
  const state = readProjectState(project);
  const ids = [];
  if (state?.lastRunId) ids.push(state.lastRunId);
  for (const id of readdirSync(root).sort().reverse()) if (!ids.includes(id)) ids.push(id);
  return { root, ids };
}

export function listRuns(project, limit = 10) {
  const { root, ids } = runIdsNewest(project);
  return ids.slice(0, limit).map((id) => readJson(join(root, id, 'run.json'))).filter(Boolean);
}

function proofFromRecord(command, state, reusable, record, currentCurrency, classification, reason) {
  const recorded = record?.currencyAfter || null;
  return {
    command,
    state,
    reusable,
    runId: record?.id || null,
    recordedStatus: record?.status || null,
    reason: reason || null,
    currency: {
      recordedHead: recorded?.head || null,
      currentHead: currentCurrency.head,
      recordedFingerprint: recorded?.worktreeFingerprint || null,
      currentFingerprint: currentCurrency.worktreeFingerprint,
      headChanged: Boolean(recorded?.head && recorded.head !== currentCurrency.head),
      classification,
    },
    raw: { stdout: record?.stdoutPath || null, stderr: record?.stderrPath || null },
    startedAt: record?.startedAt || null,
    endedAt: record?.endedAt || null,
    durationMs: record?.durationMs ?? null,
  };
}

export async function repositoryCommandProof(project, name) {
  const command = String(name || '');
  if (!discoverCommands(project.root).some((entry) => entry.name === command)) throw new Error(`Unknown repository command: ${command}`);
  const currentCurrency = await repositoryCurrency(project.root, project.identity.id);
  const classification = (record) => classifyProofCurrency(record.currencyAfter, currentCurrency);
  const { root, ids } = runIdsNewest(project);
  let newestMatching = null;
  let newestSuccessful = null;
  for (const id of ids) {
    const record = readJson(join(root, id, 'run.json'));
    if (record?.operation?.type !== 'repository-command' || record.operation.name !== command) continue;
    newestMatching ||= record;
    const proofCurrency = classification(record);
    if (proofCurrency === 'CURRENT') {
      const completePass = record.status === 'pass' && record.operation.status === 'pass' &&
        existsSync(record.stdoutPath || '') && existsSync(record.stderrPath || '');
      if (completePass) return proofFromRecord(command, 'CURRENT', true, record, currentCurrency, 'CURRENT', null);
      return proofFromRecord(command, 'MISSING', false, record, currentCurrency, 'CURRENT',
        `The newest retained attempt for current bytes is ${record.status || 'invalid'}.`);
    }
    if (!newestSuccessful && record.status === 'pass' && record.operation.status === 'pass') newestSuccessful = record;
  }
  if (!newestMatching) return proofFromRecord(command, 'MISSING', false, null, currentCurrency, 'UNKNOWN', 'No retained attempt exists for this command.');
  if (newestSuccessful) {
    const value = classification(newestSuccessful);
    return proofFromRecord(command, 'STALE', false, newestSuccessful, currentCurrency, value,
      value === 'UNKNOWN' ? 'Retained proof currency is incomplete.' : 'Repository bytes changed.');
  }
  return proofFromRecord(command, 'MISSING', false, newestMatching, currentCurrency, classification(newestMatching), 'No successful retained attempt exists for this command.');
}

export function formatRepositoryCommandProof(proof) {
  const lines = [`PROOF ${proof.state}`, `COMMAND ${proof.command}`];
  if (proof.recordedStatus) lines.push(`STATUS ${proof.recordedStatus.toUpperCase()}`);
  if (proof.runId) lines.push(`RUN ${proof.runId}`);
  if (proof.state === 'CURRENT') lines.push('EVIDENCE WORKTREE MATCH');
  if (proof.reason) lines.push(`REASON ${proof.reason}`);
  if (proof.currency.recordedHead) lines.push(`RECORDED_HEAD ${proof.currency.recordedHead.slice(0, 7)}`);
  lines.push(`CURRENT_HEAD ${proof.currency.currentHead.slice(0, 7)}`);
  lines.push(`HEAD_CHANGED ${proof.currency.headChanged}`);
  if (proof.runId) lines.push(`RAW run:${proof.runId}`);
  return lines.join('\n');
}

export function operationSequenceIdentity(record) {
  const operation = record?.operation;
  if (!operation?.type) return null;
  if (operation.type === 'repository-command') return { key: `repository-command:${operation.name}`, label: `repository-command ${operation.name}` };
  if (operation.type === 'lint') return { key: `lint:${operation.authority}`, label: `lint ${operation.authority}` };
  if (operation.type === 'terminal-command') {
    const command = operation.displayCommand || operation.command;
    return command ? { key: `terminal-command:${operation.shell}:${command}`, label: `terminal ${operation.shell} ${command}` } : null;
  }
  if (operation.type === 'search') return { key: `search:${operation.scope}:${operation.query}`, label: `search ${operation.query} in ${operation.scope}` };
  if (operation.type === 'undo') return { key: `undo:${operation.targetType}`, label: `undo ${operation.targetType}` };
  const name = operation.name || operation.displayCommand || operation.command;
  return name ? { key: `${operation.type}:${name}`, label: `${operation.type} ${name}` } : { key: operation.type, label: operation.type };
}

export function detectRepeatedOperationSequences(records, { minLength = 2, maxLength = 4, minOccurrences = 2, resultLimit = 10 } = {}) {
  if (![minLength, maxLength, minOccurrences, resultLimit].every(Number.isInteger) || minLength < 2 || maxLength < minLength || maxLength > 6 || minOccurrences < 2 || resultLimit < 1 || resultLimit > 100) {
    throw new Error('Repeated sequence bounds are invalid.');
  }
  const chronological = [...records].reverse().map((record) => {
    const identity = operationSequenceIdentity(record);
    return identity ? { record, identity } : null;
  });
  const candidates = new Map();
  for (let length = minLength; length <= maxLength; length++) {
    for (let start = 0; start + length <= chronological.length; start++) {
      const window = chronological.slice(start, start + length);
      if (window.some((entry) => !entry)) continue;
      const key = JSON.stringify(window.map((entry) => entry.identity.key));
      if (!candidates.has(key)) candidates.set(key, { sequence: window.map((entry) => entry.identity), length, occurrences: [] });
      candidates.get(key).occurrences.push({
        start,
        runIds: window.map((entry) => entry.record.id),
        statuses: window.map((entry) => entry.record.status),
        startedAt: window[0].record.startedAt,
      });
    }
  }
  const repeated = [];
  for (const candidate of candidates.values()) {
    const nonOverlapping = [];
    let previousEnd = -1;
    for (const occurrence of candidate.occurrences) {
      if (occurrence.start <= previousEnd) continue;
      nonOverlapping.push(occurrence);
      previousEnd = occurrence.start + candidate.length - 1;
    }
    if (nonOverlapping.length < minOccurrences) continue;
    const occurrences = nonOverlapping.map(({ start, ...occurrence }) => ({
      ...occurrence,
      outcome: occurrence.statuses.every((status) => status === 'pass') ? 'pass' : 'non-pass',
    }));
    repeated.push({
      sequence: candidate.sequence,
      length: candidate.length,
      count: occurrences.length,
      passCount: occurrences.filter((item) => item.outcome === 'pass').length,
      nonPassCount: occurrences.filter((item) => item.outcome !== 'pass').length,
      occurrences,
    });
  }
  return repeated.sort((a, b) => b.count - a.count || b.length - a.length || a.sequence[0].key.localeCompare(b.sequence[0].key, 'en')).slice(0, resultLimit);
}

export function repeatedOperationSequences(project, limit = 100) {
  const bounded = Number(limit);
  if (!Number.isInteger(bounded) || bounded < 2 || bounded > 500) throw new Error('hud sequences requires a history limit from 2 to 500.');
  return detectRepeatedOperationSequences(listRuns(project, bounded));
}

export function runById(project, id) {
  const value = String(id || '');
  if (!/^\d{14}-[0-9a-f]{4}$/i.test(value)) return null;
  return readJson(join(project.store, 'runs', project.key, value, 'run.json')) || null;
}

function evidenceLines(content) {
  const lines = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function boundedEvidenceNumber(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 500) {
    throw new Error(`hud ${name} requires a line count from 1 to 500.`);
  }
  return number;
}

export function projectRunEvidence(project, id, { mode = 'raw', count, pattern, context } = {}) {
  const record = runById(project, id);
  if (!record) throw new Error(`No recorded run found for ${id}.`);
  const runDirectory = join(project.store, 'runs', project.key, record.id);
  const expected = {
    stdout: join(runDirectory, 'stdout.log'),
    stderr: join(runDirectory, 'stderr.log'),
  };
  for (const stream of ['stdout', 'stderr']) {
    if (resolve(record[`${stream}Path`] || '') !== resolve(expected[stream])) {
      throw new Error(`Recorded ${stream} evidence path is invalid for ${record.id}.`);
    }
    if (!existsSync(expected[stream])) throw new Error(`Recorded ${stream} evidence is missing for ${record.id}.`);
  }
  if (!['raw', 'head', 'tail', 'find', 'around'].includes(mode)) throw new Error(`Unknown evidence projection: ${mode}.`);
  const needle = pattern === undefined ? null : String(pattern);
  if ((mode === 'find' || mode === 'around') && !needle) throw new Error(`hud ${mode} requires a non-empty pattern.`);
  const lineCount = mode === 'head' || mode === 'tail' ? boundedEvidenceNumber(count, 20, mode) : null;
  const contextCount = mode === 'around' ? boundedEvidenceNumber(context, 2, mode) : null;

  const streams = ['stdout', 'stderr'].map((stream) => {
    const content = readFileSync(expected[stream], 'utf8');
    const all = evidenceLines(content);
    if (mode === 'raw') return { stream, totalLines: all.length, content };
    let indexes;
    if (mode === 'head') indexes = all.slice(0, lineCount).map((_, index) => index);
    else if (mode === 'tail') indexes = all.slice(Math.max(0, all.length - lineCount)).map((_, index) => Math.max(0, all.length - lineCount) + index);
    else {
      const matches = all.flatMap((line, index) => line.includes(needle) ? [index] : []);
      if (mode === 'find') indexes = matches;
      else {
        const selected = new Set();
        for (const index of matches) {
          const first = Math.max(0, index - contextCount);
          const last = Math.min(all.length - 1, index + contextCount);
          for (let selectedIndex = first; selectedIndex <= last; selectedIndex++) selected.add(selectedIndex);
        }
        indexes = [...selected].sort((a, b) => a - b);
      }
      const boundedIndexes = indexes.slice(0, 500);
      return {
        stream,
        totalLines: all.length,
        matchCount: matches.length,
        truncated: boundedIndexes.length < indexes.length,
        lines: boundedIndexes.map((index) => ({ number: index + 1, text: all[index] })),
      };
    }
    return { stream, totalLines: all.length, lines: indexes.map((index) => ({ number: index + 1, text: all[index] })) };
  });
  return {
    runId: record.id,
    command: record.command,
    status: record.status,
    exitCode: record.exitCode,
    mode,
    pattern: needle,
    count: lineCount,
    context: contextCount,
    streams,
  };
}

export async function diffRunEvidence(project, leftId, rightId, { maxLines = 500, maxChars = 64 * 1024 } = {}) {
  projectRunEvidence(project, leftId);
  projectRunEvidence(project, rightId);
  const boundedLines = boundedEvidenceNumber(maxLines, 500, 'diff');
  if (!Number.isInteger(maxChars) || maxChars < 1024 || maxChars > 1024 * 1024) throw new Error('hud diff requires a character bound from 1024 to 1048576.');
  const runRoot = join(project.store, 'runs', project.key);
  const streams = [];
  for (const stream of ['stdout', 'stderr']) {
    const leftPath = join(runRoot, leftId, `${stream}.log`);
    const rightPath = join(runRoot, rightId, `${stream}.log`);
    const result = await exec('git', ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', leftPath, rightPath], project.root, { trim: false });
    if (result.code > 1) throw new Error(`Unable to compare recorded ${stream}: ${result.stderr}`);
    const normalized = result.stdout.split(/\r?\n/).map((line) => {
      if (line.startsWith('diff --git ')) return `diff --git a/${stream}:${leftId} b/${stream}:${rightId}`;
      if (line.startsWith('--- ')) return `--- ${stream}:${leftId}`;
      if (line.startsWith('+++ ')) return `+++ ${stream}:${rightId}`;
      return line;
    }).join('\n');
    const lines = evidenceLines(normalized);
    let selected = lines.slice(0, boundedLines);
    let text = selected.join('\n');
    let truncated = selected.length < lines.length;
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    streams.push({ stream, different: result.code === 1, totalLines: lines.length, truncated, text });
  }
  return {
    leftRunId: leftId,
    rightRunId: rightId,
    different: streams.some((stream) => stream.different),
    streams,
  };
}

export async function operationHistory(project, limit = 25) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 25));
  const currency = await repositoryCurrency(project.root, project.identity.id);
  return listRuns(project, 100).filter((record) => record.operation).slice(0, bounded).map((record) => ({
    runId: record.id,
    type: record.operation.type,
    name: record.operation.name || (record.operation.type === 'lint' ? `Lint ${record.operation.authority}` : record.operation.type === 'undo' ? `Undo ${record.operation.targetRunId}` : null),
    query: record.operation.query || null,
    scope: record.operation.scope || '.',
    command: record.operation.command,
    status: record.status,
    provenance: record.provenance || { origin: 'legacy-unknown', finalizedBy: 'unknown' },
    durationMs: record.durationMs,
    startedAt: record.startedAt,
    evidence: classifyEvidence(record.currencyAfter, currency),
    reversible: Boolean(record.delta?.patchPath && record.delta?.paths?.length),
    result: record.status === 'interrupted' ? 'Interrupted; completion not observed'
      : record.operation.type === 'search'
      ? `${record.operation.matchCount} matches / ${record.operation.fileCount} files`
      : record.operation.type === 'lint'
        ? `${record.operation.diagnosticCount} diagnostics / ${record.operation.fileCount} files`
      : record.operation.type === 'undo'
        ? `${record.operation.fileCount} files restored`
        : record.operation.summary?.join('; ') || `exit ${record.exitCode}`,
  }));
}

export async function operationDetail(project, id) {
  const record = runById(project, id);
  if (!record?.operation) return null;
  const currency = await repositoryCurrency(project.root, project.identity.id);
  const context = buildOperationContext(project, record, { currentCurrency: currency });
  return {
    runId: record.id,
    operation: record.operation,
    provenance: record.provenance || { origin: 'legacy-unknown', finalizedBy: 'unknown' },
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
