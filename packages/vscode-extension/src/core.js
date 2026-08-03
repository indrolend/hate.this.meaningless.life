'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');

function run(executable, args, cwd) {
  return new Promise((resolve) => {
    execFile(executable, args, { cwd, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({
        ok: !error,
        code: error && Number.isInteger(error.code) ? error.code : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      }));
  });
}

async function inspectProject(cwd) {
  const [root, branch, head, status] = await Promise.all([
    run('git', ['rev-parse', '--show-toplevel'], cwd),
    run('git', ['branch', '--show-current'], cwd),
    run('git', ['rev-parse', 'HEAD'], cwd),
    run('git', ['status', '--short'], cwd)
  ]);
  if (!root.ok) return { root: cwd, repository: false, branch: '', head: '', changes: [] };
  return {
    root: root.stdout,
    repository: true,
    branch: branch.stdout || '(detached)',
    head: head.stdout,
    changes: status.stdout ? status.stdout.split(/\r?\n/) : []
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

module.exports = { run, inspectProject, createOrder, agentPacket, cleanIntent };
