'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  createOrder,
  agentPacket,
  cleanIntent,
  defaultCloneDestination,
  isForbiddenImplicitProject,
  sameOrigin,
  inspectProject,
  run,
  deriveCloneFolderName,
  appendHistoryRecord,
  readHistoryRecords,
  latestHistoryOutput,
  historyTranscript,
  commandInputAction,
  startProjectCommand,
  discoverFixture,
  loadOrders
} = require('../src/core');

const project = { root: '/repo', branch: 'main', head: 'abc123', changes: [' M game.cpp'] };

async function makeTempRoot(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

test('normalizes intent without erasing structure', () => {
  assert.equal(cleanIntent(' fix this  \r\nthen test  '), 'fix this\nthen test');
});

test('creates a reproducible bounded order', () => {
  const order = createOrder('Fix controls', project, new Date('2026-08-03T12:00:00Z'));
  assert.match(order.id, /^order-20260803120000-/);
  assert.equal(order.authority.commit, 'abc123');
  assert.equal(order.status, 'ready');
});

test('agent packet retains authority and evidence', () => {
  const order = createOrder('Fix controls', project, new Date('2026-08-03T12:00:00Z'));
  const packet = agentPacket(order);
  assert.match(packet, /GOAL: Fix controls/);
  assert.match(packet, /commit: abc123/);
  assert.match(packet, /commands and exit codes/);
});

test('rejects empty goals', () => {
  assert.throws(() => createOrder('  ', project), /empty/);
});

test('successful execFile result records exit code 0', async () => {
  const result = await run('git', ['status'], '/repo', {
    execFileImpl(executable, args, options, callback) {
      callback(null, 'ok\n', '');
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.classification, 'exit');
});

test('spawn failure remains distinguishable from a normal exit', async () => {
  const result = await run('git', ['status'], '/repo', {
    execFileImpl(executable, args, options, callback) {
      const error = new Error('spawn git ENOENT');
      error.code = 'ENOENT';
      callback(error, '', '');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.equal(result.classification, 'spawn-failed');
});

test('missing Git produces GIT MISSING', async () => {
  const result = await inspectProject('/repo', {
    runOptions: {
      execFileImpl(executable, args, options, callback) {
        const error = new Error('spawn git ENOENT');
        error.code = 'ENOENT';
        callback(error, '', '');
      }
    }
  });
  assert.equal(result.state, 'GIT MISSING');
  assert.equal(result.verified, false);
});

test('clone destination is deterministic and derived from the repository', () => {
  assert.equal(deriveCloneFolderName('git@github.com:Indrolend/Digital-Breakdown-APK.git'), 'digital-breakdown-apk');
  assert.equal(
    defaultCloneDestination('C:\\Users\\alice', 'https://github.com/indrolend/hate.this.meaningless.life.git'),
    'C:\\Users\\alice\\Projects\\hate.this.meaningless.life'
  );
});

test('arbitrary repository URLs derive non-colliding destinations', () => {
  const existing = ['C:\\Users\\alice\\Projects\\repo'];
  assert.equal(
    defaultCloneDestination('C:\\Users\\alice', 'https://github.com/example/repo.git', existing),
    'C:\\Users\\alice\\Projects\\example-repo'
  );
  assert.equal(
    defaultCloneDestination('C:\\Users\\alice', 'https://gitlab.com/example/repo.git', [
      'C:\\Users\\alice\\Projects\\repo',
      'C:\\Users\\alice\\Projects\\example-repo',
      'C:\\Users\\alice\\Projects\\gitlab.com-example-repo'
    ]),
    'C:\\Users\\alice\\Projects\\repo-2'
  );
});

test('startup does not implicitly select profile roots', () => {
  const home = 'C:\\Users\\alice';
  assert.equal(isForbiddenImplicitProject(home, home), true);
  assert.equal(isForbiddenImplicitProject(`${home}\\Desktop`, home), true);
  assert.equal(isForbiddenImplicitProject(`${home}\\Downloads`, home), true);
  assert.equal(isForbiddenImplicitProject(`${home}\\Projects\\digital-breakdown-apk`, home), false);
});

test('SSH and HTTPS origins compare consistently', () => {
  assert.equal(sameOrigin('https://GitHub.com/Indrolend/Hate.This.Meaningless.Life.git/', 'git@github.com:indrolend/hate.this.meaningless.life.git'), true);
  assert.equal(sameOrigin('ssh://git@github.com/INDROLEND/Digital-Breakdown-APK.git', 'https://github.com/indrolend/digital-breakdown-apk/'), true);
  assert.equal(sameOrigin('https://github.com/indrolend/hate.this.meaningless.life.git', 'https://github.com/indrolend/digital-breakdown-apk.git'), false);
});

test('missing project yields NO PROJECT', async () => {
  const missing = await inspectProject('');
  assert.equal(missing.state, 'NO PROJECT');
  assert.equal(missing.verified, false);
});

test('Enter and Shift+Enter have distinct behavior', () => {
  assert.equal(commandInputAction('Enter', false), 'run');
  assert.equal(commandInputAction('Enter', true), 'newline');
  assert.equal(commandInputAction('Escape', false), null);
});

test('no command runs without a verified root', async () => {
  await assert.rejects(() => startProjectCommand('echo nope', { root: '', verified: false }), /NO VERIFIED ROOT/);
});

test('every command receives the verified root as cwd', async () => {
  let received;
  const execution = await startProjectCommand('echo ok', { root: '/verified', verified: true }, {
    now: () => new Date('2026-08-03T12:00:00Z'),
    fsModule: {
      mkdir: async () => {},
      writeFile: async () => {},
      appendFile: async () => {}
    },
    spawnImpl(command, options) {
      received = { command, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      child.kill = () => {};
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    }
  });
  const result = await execution.done;
  assert.equal(received.options.cwd, '/verified');
  assert.equal(result.cwd, '/verified');
  assert.equal(result.exitCode, 0);
});

test('asynchronous output is captured once', async () => {
  const root = await makeTempRoot('df-output');
  const execution = await startProjectCommand(
    `${process.execPath} -e "process.stdout.write('once\\n'); setTimeout(() => process.stdout.write('twice\\n'), 25); setTimeout(() => process.exit(0), 50);"`,
    { root, verified: true }
  );
  const result = await execution.done;
  const history = await readHistoryRecords(root);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.match(/once/g).length, 1);
  assert.equal(result.output.match(/twice/g).length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].output.match(/once/g).length, 1);
  assert.equal(history[0].output.match(/twice/g).length, 1);
});

test('STOP cancels without recording PASS', async () => {
  const root = await makeTempRoot('df-stop');
  const execution = await startProjectCommand(
    `${process.execPath} -e "setTimeout(() => process.stdout.write('late\\n'), 5000)"`,
    { root, verified: true }
  );
  setTimeout(() => execution.stop(), 100);
  const result = await execution.done;
  const history = await readHistoryRecords(root);
  assert.equal(result.status, 'stopped');
  assert.equal(result.ok, false);
  assert.notEqual(history[0].status, 'passed');
});

test('COPY returns latest output only and ALL returns ordered history', async () => {
  const root = await makeTempRoot('df-history');
  await appendHistoryRecord(root, { command: 'echo first', output: 'first', startedAt: '2026-08-03T12:00:00Z' });
  await appendHistoryRecord(root, { command: 'echo second', output: 'second', startedAt: '2026-08-03T12:00:01Z' });
  const history = await readHistoryRecords(root);
  assert.equal(latestHistoryOutput(history), 'second');
  assert.equal(historyTranscript(history), '$ echo first\nfirst\n\n$ echo second\nsecond');
});

test('histories are isolated between two projects', async () => {
  const left = await makeTempRoot('df-left');
  const right = await makeTempRoot('df-right');
  await appendHistoryRecord(left, { command: 'echo left', output: 'left', startedAt: '2026-08-03T12:00:00Z' });
  await appendHistoryRecord(right, { command: 'echo right', output: 'right', startedAt: '2026-08-03T12:00:00Z' });
  assert.equal(historyTranscript(await readHistoryRecords(left)), '$ echo left\nleft');
  assert.equal(historyTranscript(await readHistoryRecords(right)), '$ echo right\nright');
});

test('Digital Breakdown discovery performs no writes when the fixture is unavailable', async () => {
  let inspected = false;
  const result = await discoverFixture('/fixture.json', {
    env: { USERPROFILE: 'C:\\Users\\alice' },
    readFile: async () => JSON.stringify({
      name: 'Digital Breakdown',
      repository: 'https://github.com/indrolend/digital-breakdown-apk.git',
      visibility: 'private',
      defaultClonePath: '%USERPROFILE%\\Projects\\digital-breakdown-apk',
      discover: ['AGENTS.md']
    }),
    exists: async () => false,
    inspectProjectImpl: async () => {
      inspected = true;
      return null;
    }
  });
  assert.equal(result.state, 'AUTH');
  assert.equal(inspected, false);
});

test('orders load from the verified project root', async () => {
  const root = await makeTempRoot('df-orders');
  const orderA = createOrder('First', { root, branch: 'main', head: 'aaa111', changes: [] }, new Date('2026-08-03T12:00:00Z'));
  const orderB = createOrder('Second', { root, branch: 'main', head: 'bbb222', changes: [] }, new Date('2026-08-03T12:01:00Z'));
  const directory = path.join(root, '.datafactory', 'orders');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${orderA.id}.json`), JSON.stringify(orderA), 'utf8');
  await fs.writeFile(path.join(directory, `${orderB.id}.json`), JSON.stringify(orderB), 'utf8');
  const orders = await loadOrders(root);
  assert.deepEqual(orders.map((item) => item.intent), ['First', 'Second']);
});
