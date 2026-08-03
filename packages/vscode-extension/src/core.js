'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

function run(executable, args, cwd) {
  return new Promise((resolve) => {
    execFile(executable, args, { cwd, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({
        ok: !error,
        code: error && Number.isInteger(error.code) ? error.code : 1,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      }));
  });
}

function normalizeOrigin(origin) {
  const value = String(origin || '').trim().replace(/\\/g, '/');
  if (!value) return '';
  const ssh = value.match(/^git@([^:]+):(.+)$/i);
  if (ssh) {
    return `${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/i, '').toLowerCase()}`;
  }
  try {
    const parsed = new URL(value);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\.git$/i, '').toLowerCase()}`;
  } catch {
    return value.replace(/\.git$/i, '').toLowerCase();
  }
}

function sameOrigin(expected, actual) {
  if (!expected) return true;
  return normalizeOrigin(expected) === normalizeOrigin(actual);
}

function defaultCloneDestination(home = process.env.USERPROFILE || os.homedir()) {
  const p = String(home || '').includes('\\') && !String(home || '').includes('/')
    ? path.win32
    : path;
  return p.join(home, 'Projects', 'hate.this.meaningless.life');
}

function isForbiddenImplicitProject(candidate, home = process.env.USERPROFILE || os.homedir()) {
  const p = String(home || '').includes('\\') && !String(home || '').includes('/')
    ? path.win32
    : path;
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
  if (!cwd) return { root: '', repository: false, branch: '', head: '', origin: '', changes: [], state: 'NO PROJECT', verified: false };
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!root.ok) {
    const output = `${root.stderr}\n${root.stdout}`.toLowerCase();
    const state = root.code === 127 || output.includes('not found')
      ? 'GIT MISSING'
      : 'NO PROJECT';
    return { root: cwd, repository: false, branch: '', head: '', origin: '', changes: [], state, verified: false };
  }
  const [branch, head, status, origin] = await Promise.all([
    run('git', ['branch', '--show-current'], root.stdout),
    run('git', ['rev-parse', 'HEAD'], root.stdout),
    run('git', ['status', '--short'], root.stdout),
    run('git', ['remote', 'get-url', 'origin'], root.stdout)
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

module.exports = {
  run,
  inspectProject,
  createOrder,
  agentPacket,
  cleanIntent,
  normalizeOrigin,
  sameOrigin,
  defaultCloneDestination,
  isForbiddenImplicitProject
};
