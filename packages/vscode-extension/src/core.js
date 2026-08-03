'use strict';

const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function choosePathLibrary(sample) {
  return String(sample || '').includes('\\') && !String(sample || '').includes('/')
    ? path.win32
    : path;
}

function run(executable, args, cwd, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  return new Promise((resolve) => {
    execFileImpl(executable, args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const spawnFailure = Boolean(error) && !Number.isInteger(error.code);
      resolve({
        ok: !error,
        code: error
          ? (Number.isInteger(error.code) ? error.code : null)
          : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        classification: error
          ? (spawnFailure ? 'spawn-failed' : 'exit')
          : 'exit',
        error: error || null
      });
    });
  });
}

function normalizeOrigin(origin) {
  const value = String(origin || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!value) return '';

  const sshLike = value.match(/^(?:ssh:\/\/)?([^@/]+@)?([^:/]+)[:/]([^?#]+)$/i);
  if (sshLike && !value.includes('://')) {
    return `${sshLike[2].toLowerCase()}/${sshLike[3]}`
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }

  try {
    const parsed = new URL(value);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    return value.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  }
}

function sameOrigin(expected, actual) {
  if (!expected) return true;
  return normalizeOrigin(expected) === normalizeOrigin(actual);
}

function repositoryDescriptor(repository) {
  const normalized = normalizeOrigin(repository);
  const segments = normalized.split('/').filter(Boolean);
  return {
    normalized,
    host: segments[0] || '',
    owner: segments.length > 2 ? segments[segments.length - 2] : '',
    name: segments[segments.length - 1] || 'repository'
  };
}

function deriveCloneFolderName(repository) {
  return repositoryDescriptor(repository).name || 'repository';
}

function defaultCloneDestination(home = process.env.USERPROFILE || os.homedir(), repository = 'https://github.com/indrolend/hate.this.meaningless.life.git', existingPaths = []) {
  const p = choosePathLibrary(home);
  const baseDirectory = p.join(home, 'Projects');
  const { host, owner, name } = repositoryDescriptor(repository);
  const candidates = [
    name,
    owner ? `${owner}-${name}` : '',
    host && owner ? `${host}-${owner}-${name}` : ''
  ].filter(Boolean);
  const taken = new Set(existingPaths.map((entry) => p.resolve(String(entry || '')).toLowerCase()));

  for (const candidate of candidates) {
    const next = p.join(baseDirectory, candidate);
    if (!taken.has(p.resolve(next).toLowerCase())) return next;
  }

  let suffix = 2;
  while (true) {
    const next = p.join(baseDirectory, `${name}-${suffix}`);
    if (!taken.has(p.resolve(next).toLowerCase())) return next;
    suffix += 1;
  }
}

function isForbiddenImplicitProject(candidate, home = process.env.USERPROFILE || os.homedir()) {
  const p = choosePathLibrary(home);
  const normalized = p.resolve(String(candidate || ''));
  const homeRoot = p.resolve(home);
  const blocked = [
    homeRoot,
    p.join(homeRoot, 'Desktop'),
    p.join(homeRoot, 'Downloads')
  ];
  return blocked.some((value) => normalized === p.resolve(value));
}

async function inspectProject(cwd, options = {}) {
  if (!cwd) {
    return { root: '', repository: false, branch: '', head: '', origin: '', changes: [], state: 'NO PROJECT', verified: false };
  }

  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd, options.runOptions);
  if (!root.ok) {
    const output = `${root.stderr}\n${root.stdout}\n${root.error?.message || ''}`.toLowerCase();
    const state = root.classification === 'spawn-failed' || output.includes('enoent') || output.includes('not found')
      ? 'GIT MISSING'
      : 'NO PROJECT';
    return { root: cwd, repository: false, branch: '', head: '', origin: '', changes: [], state, verified: false };
  }

  const [branch, head, status, origin] = await Promise.all([
    run('git', ['branch', '--show-current'], root.stdout, options.runOptions),
    run('git', ['rev-parse', 'HEAD'], root.stdout, options.runOptions),
    run('git', ['status', '--short'], root.stdout, options.runOptions),
    run('git', ['remote', 'get-url', 'origin'], root.stdout, options.runOptions)
  ]);

  const originMismatch = options.expectedOrigin && !sameOrigin(options.expectedOrigin, origin.stdout);
  const rootMismatch = options.expectedRoot && path.resolve(options.expectedRoot) !== path.resolve(root.stdout);
  const stale = Boolean(options.expectedCommit && options.expectedCommit !== head.stdout);
  const dirty = status.stdout ? status.stdout.split(/\r?\n/) : [];
  const state = originMismatch || rootMismatch
    ? 'AUTH'
    : stale
      ? 'STALE'
      : dirty.length
        ? 'DIRTY'
        : 'READY';

  return {
    root: root.stdout,
    repository: true,
    branch: branch.stdout || '(detached)',
    head: head.stdout,
    origin: origin.ok ? origin.stdout : '',
    changes: dirty,
    state,
    verified: !(originMismatch || rootMismatch)
  };
}

function cleanIntent(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

function createOrder(intent, project, now = new Date()) {
  const goal = cleanIntent(intent);
  if (!goal) throw new Error('Goal is empty.');
  const seed = `${now.toISOString()}\n${project.head || ''}\n${goal}`;
  return {
    schema: 1,
    id: `order-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 6)}`,
    createdAt: now.toISOString(),
    status: 'ready',
    intent: goal,
    authority: {
      root: project.root,
      branch: project.branch || null,
      commit: project.head || null,
      dirty: project.changes || []
    },
    constraints: [
      'Preserve unrelated user work.',
      'Do not publish, deploy, merge, or force-push without approval.',
      'Treat repository scripts and tests as the verification authority.'
    ],
    evidenceRequired: ['changed files', 'commands and exit codes', 'tests run', 'remaining unknowns']
  };
}

function agentPacket(order) {
  const dirty = order.authority.dirty.length
    ? order.authority.dirty.map((line) => `  - ${line}`).join('\n')
    : '  - clean';
  return [
    `ORDER: ${order.id}`,
    `GOAL: ${order.intent}`,
    '',
    'AUTHORITY:',
    `  root: ${order.authority.root}`,
    `  branch: ${order.authority.branch || 'none'}`,
    `  commit: ${order.authority.commit || 'none'}`,
    '  working tree:', dirty,
    '',
    'CONSTRAINTS:',
    ...order.constraints.map((item) => `  - ${item}`),
    '',
    'RETURN:',
    ...order.evidenceRequired.map((item) => `  - ${item}`)
  ].join('\n');
}

function dataFactoryDirectory(root) {
  return path.join(root, '.datafactory');
}

function ordersDirectory(root) {
  return path.join(dataFactoryDirectory(root), 'orders');
}

function logsDirectory(root) {
  return path.join(dataFactoryDirectory(root), 'logs');
}

function historyFile(root) {
  return path.join(dataFactoryDirectory(root), 'history.jsonl');
}

async function appendHistoryRecord(root, record, fsModule = fs) {
  await fsModule.mkdir(dataFactoryDirectory(root), { recursive: true });
  await fsModule.appendFile(historyFile(root), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

async function readHistoryRecords(root, fsModule = fs) {
  try {
    const text = await fsModule.readFile(historyFile(root), 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .sort((left, right) => String(left.startedAt || '').localeCompare(String(right.startedAt || '')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function latestHistoryOutput(records) {
  return records.length ? String(records[records.length - 1].output || '').trimEnd() : '';
}

function historyTranscript(records) {
  return records.map((record) => {
    const parts = [`$ ${record.command}`];
    if (record.output) parts.push(String(record.output).trimEnd());
    return parts.join('\n');
  }).join('\n\n').trim();
}

async function loadOrders(root, fsModule = fs) {
  try {
    const names = (await fsModule.readdir(ordersDirectory(root))).filter((name) => name.endsWith('.json')).sort();
    const orders = await Promise.all(names.map(async (name) => JSON.parse(await fsModule.readFile(path.join(ordersDirectory(root), name), 'utf8'))));
    return orders.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function commandInputAction(key, shiftKey) {
  if (key !== 'Enter') return null;
  return shiftKey ? 'newline' : 'run';
}

async function startProjectCommand(command, project, options = {}) {
  if (!project?.verified || !project?.root) {
    throw new Error('NO VERIFIED ROOT');
  }

  const spawnImpl = options.spawnImpl || spawn;
  const fsModule = options.fsModule || fs;
  const now = options.now || (() => new Date());
  const startedAt = new Date(now());
  const stamp = startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `${stamp}-${crypto.createHash('sha256').update(`${startedAt.toISOString()}\n${project.root}\n${command}`).digest('hex').slice(0, 6)}`;
  const logPath = path.join(logsDirectory(project.root), `${id}.log`);

  await fsModule.mkdir(logsDirectory(project.root), { recursive: true });
  await fsModule.writeFile(logPath, '', 'utf8');

  const listeners = { output: new Set(), done: new Set() };
  let output = '';
  let stopping = false;
  let finished = false;
  let spawnError = null;
  let writeChain = Promise.resolve();

  const emit = (type, value) => {
    for (const listener of listeners[type]) listener(value);
  };

  const appendOutput = (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    output += text;
    writeChain = writeChain.then(() => fsModule.appendFile(logPath, text, 'utf8'));
    emit('output', text);
  };

  const child = spawnImpl(command, { cwd: project.root, shell: true, windowsHide: true });
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on?.('data', appendOutput);
  child.stderr?.on?.('data', appendOutput);

  const done = new Promise((resolve) => {
    const finalize = async (code, signal) => {
      if (finished) return;
      finished = true;
      await writeChain;
      const endedAt = new Date(now());
      const result = {
        id,
        command,
        cwd: project.root,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        exitCode: spawnError
          ? null
          : (stopping ? 130 : (Number.isInteger(code) ? code : null)),
        signal: signal || null,
        status: spawnError
          ? 'failed'
          : (stopping ? 'stopped' : (code === 0 ? 'passed' : 'failed')),
        classification: spawnError
          ? 'spawn-failed'
          : (stopping ? 'stopped' : 'exit'),
        ok: !spawnError && !stopping && code === 0,
        output: output.trimEnd(),
        logPath
      };
      await appendHistoryRecord(project.root, result, fsModule);
      emit('done', result);
      resolve(result);
    };

    child.on?.('error', (error) => {
      spawnError = error;
      appendOutput(`${error.message}\n`);
      finalize(null, null);
    });

    child.on?.('close', (code, signal) => {
      finalize(code, signal);
    });
  });

  return {
    id,
    command,
    cwd: project.root,
    startedAt: startedAt.toISOString(),
    logPath,
    stop() {
      stopping = true;
      if (!finished && child.kill) child.kill();
    },
    getOutput() {
      return output;
    },
    onOutput(listener) {
      listeners.output.add(listener);
      return () => listeners.output.delete(listener);
    },
    onDone(listener) {
      listeners.done.add(listener);
      return () => listeners.done.delete(listener);
    },
    done
  };
}

function expandWindowsEnv(text, env = process.env) {
  return String(text || '').replace(/%([^%]+)%/g, (_, name) => env[name] || `%${name}%`);
}

async function discoverFixture(configPath, options = {}) {
  const readFile = options.readFile || ((target) => fs.readFile(target, 'utf8'));
  const exists = options.exists || (async (target) => {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  });
  const inspectProjectImpl = options.inspectProjectImpl || inspectProject;
  const env = options.env || process.env;

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const clonePath = expandWindowsEnv(config.defaultClonePath || '', env);
  const available = clonePath ? await exists(clonePath) : false;
  if (!available) {
    return {
      name: config.name,
      repository: config.repository,
      clonePath,
      state: config.visibility === 'private' ? 'AUTH' : 'MISSING',
      discovered: []
    };
  }

  const project = await inspectProjectImpl(clonePath, { expectedOrigin: config.repository });
  const discovered = [];
  for (const entry of config.discover || []) {
    if (await exists(path.join(project.root, entry))) discovered.push(entry);
  }

  return {
    name: config.name,
    repository: config.repository,
    clonePath,
    state: project.verified ? project.state : 'AUTH',
    root: project.root,
    origin: project.origin,
    discovered
  };
}

module.exports = {
  run,
  inspectProject,
  createOrder,
  agentPacket,
  cleanIntent,
  normalizeOrigin,
  sameOrigin,
  deriveCloneFolderName,
  defaultCloneDestination,
  isForbiddenImplicitProject,
  appendHistoryRecord,
  readHistoryRecords,
  latestHistoryOutput,
  historyTranscript,
  loadOrders,
  commandInputAction,
  startProjectCommand,
  discoverFixture,
  dataFactoryDirectory,
  ordersDirectory,
  logsDirectory,
  historyFile
};
