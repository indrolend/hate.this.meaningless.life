import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPacket, fetchUpdate, formatPacket, gitSnapshot, reduceOutput, resolveProject, runCommand } from './core.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hud-fixture-'));
  mkdirSync(join(root, 'distribution'));
  writeFileSync(join(root, 'distribution', 'project.json'), JSON.stringify({ id: 'indrolend/data', channel: 'latest-native', manifest: 'https://example.invalid/manifest.json' }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  writeFileSync(join(root, 'file.txt'), 'initial\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return root;
}

test('reducers retain concise evidence and cause classification', () => {
  const pass = reduceOutput('npm test', '100% tests passed, 0 tests failed out of 9', '', 0);
  assert.deepEqual(pass.summary, ['9/9 CTest']);
  const compactPass = reduceOutput('npm test', '100% tests passed out of 9\nMULTIPLAYER_PROTOCOL_OK', '', 0);
  assert.deepEqual(compactPass.summary, ['9/9 CTest', 'multiplayer protocol']);
  const fail = reduceOutput('npm test', '', 'Error: assertion failed', 1);
  assert.equal(fail.classification, 'test');
});

test('verified project execution persists immutable evidence and packet', async () => {
  const root = fixture();
  const env = { ...process.env, HUD_STATE_ROOT: join(root, '.state') };
  const project = await resolveProject({ cwd: root, env });
  const record = await runCommand(project, [process.execPath, '-e', 'console.log("SMOKE_TEST_OK")'], { objective: 'prove success', stream: false });
  assert.equal(record.status, 'pass');
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /SMOKE_TEST_OK/);
  assert.match(formatPacket(record.packet), /STATUS=PASS/);
  assert.ok(readFileSync(record.stdoutPath.replace(/stdout\.log$/, 'run.json'), 'utf8').includes(record.id));
});

test('failed commands remain failed while preserving raw stderr', async () => {
  const root = fixture();
  const project = await resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } });
  const record = await runCommand(project, [process.execPath, '-e', 'console.error("Error: expected failure"); process.exit(7)'], { stream: false });
  assert.equal(record.status, 'fail');
  assert.equal(record.exitCode, 7);
  assert.match(readFileSync(record.stderrPath, 'utf8'), /expected failure/);
});

test('wrong repositories are rejected and dirty state is captured', async () => {
  const root = fixture();
  writeFileSync(join(root, 'file.txt'), 'dirty\n');
  assert.equal((await gitSnapshot(root)).dirty, true);
  const wrong = mkdtempSync(join(tmpdir(), 'hud-wrong-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: wrong });
  await assert.rejects(resolveProject({ cwd: wrong, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } }), /not the verified/);
});

test('update comparison uses canonical manifest commit and platform artifact', async () => {
  const root = fixture();
  const project = await resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } });
  const head = (await gitSnapshot(root)).head;
  const response = { ok: true, json: async () => ({ commit: head, artifacts: { 'windows-x64': { sha256: 'abc' } } }) };
  const update = await fetchUpdate(project, async () => response);
  assert.equal(update.status, 'current');

  writeFileSync(join(root, 'file.txt'), 'new local commit\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'local ahead'], { cwd: root });
  const ahead = await fetchUpdate(project, async () => response);
  assert.equal(ahead.status, 'local_ahead');
});

test('packet schema contains only deterministic continuation fields', () => {
  const packet = buildPacket({
    status: 'pass', objective: 'test', command: 'npm test', exitCode: 0,
    gitAfter: { head: 'a'.repeat(40), branch: 'main', dirty: false, changedFiles: [] },
    reduction: { summary: ['9/9 CTest'], cause: null }, stdoutPath: 'out', stderrPath: 'err',
  });
  assert.deepEqual(Object.keys(packet), ['STATUS', 'OBJECTIVE', 'AUTHORITY', 'CHANGE', 'VERIFY', 'RESULT', 'FRONTIER']);
});
