import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProject, searchRepository } from './core.mjs';
import { startHudServer } from './server.mjs';

function fixtureProject() {
  const root = mkdtempSync(join(tmpdir(), 'hud-server-'));
  mkdirSync(join(root, 'distribution'));
  mkdirSync(join(root, 'media'));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'distribution', 'project.json'), JSON.stringify({
    id: 'indrolend/data',
    channel: 'test',
    manifest: 'https://example.invalid/manifest.json',
  }));
  writeFileSync(join(root, 'media', 'tone.mp3'), Buffer.from([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]));
  writeFileSync(join(root, 'media', 'tone.wav'), Buffer.from('RIFFtestWAVE'));
  writeFileSync(join(root, 'media', 'clip.mp4'), Buffer.from('test-mp4'));
  writeFileSync(join(root, 'media', 'clip.mov'), Buffer.from('test-mov'));
  writeFileSync(join(root, 'tools', 'run-native-tests.mjs'), 'import { writeFileSync } from "node:fs"; console.log("STARTED"); writeFileSync(new URL("../media/generated.txt", import.meta.url), "created by command\\n"); await new Promise((resolve) => setTimeout(resolve, 1200)); console.log("x".repeat(70000)); console.log("100% tests passed, 0 tests failed out of 2")\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return resolveProject({
    cwd: root,
    env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'hud-server-state-')) },
  });
}

async function waitForActiveRun(base, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await (await fetch(`${base}/runtime`)).json();
    if (runtime.busy?.runId) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for an active HUD run.');
}

async function waitForActiveEvidence(base, runId, pattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/runtime/evidence/stdout?run=${runId}&tail=10`);
    if (response.ok) {
      const evidence = await response.json();
      if (pattern.test(evidence.text)) return evidence;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for active HUD evidence.');
}

test('HUD server refuses corrupt interrupted evidence', async () => {
  const project = await fixtureProject();
  const id = '20260824220300-cafe';
  const directory = join(project.store, 'runs', project.key, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'inflight.json'), '{"truncated":');
  await assert.rejects(() => startHudServer(project, { port: 0 }), new RegExp(`Interrupted evidence is corrupt for run ${id}`));
});

test('terminal execution is desktop-only and persists repository-contained cwd', async (t) => {
  const staticProject = await fixtureProject();
  const restricted = await startHudServer(staticProject, { port: 0 });
  t.after(() => restricted.server.close());
  const restrictedBase = `http://127.0.0.1:${restricted.port}`;
  const restrictedRuntime = await (await fetch(`${restrictedBase}/runtime`)).json();
  assert.equal(restrictedRuntime.capabilities.terminal, false);
  const refused = await fetch(`${restrictedBase}/operations/terminal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: 'powershell', command: 'echo no' }),
  });
  assert.equal(refused.status, 403);

  const project = await fixtureProject();
  const running = await startHudServer(project, { port: 0, terminal: true });
  t.after(() => running.server.close());
  const base = `http://127.0.0.1:${running.port}`;
  const runtime = await (await fetch(`${base}/runtime`)).json();
  assert.equal(runtime.capabilities.terminal, true);
  const shell = runtime.capabilities.shells.find((entry) => entry.available && entry.id === (process.platform === 'win32' ? 'powershell' : 'bash'));
  assert.ok(shell);
  const changeDirectory = shell.id === 'powershell' ? 'Set-Location tools' : 'cd tools';
  const first = await fetch(`${base}/operations/terminal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: shell.id, command: changeDirectory }),
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).operation.cwdPersistence, 'updated');
  const after = await (await fetch(`${base}/runtime`)).json();
  assert.equal(after.terminal.displayCwd, 'tools');
  const exact = 'echo HUD_TERMINAL_OK';
  const second = await fetch(`${base}/operations/terminal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: shell.id, command: exact }),
  });
  const result = await second.json();
  assert.equal(second.status, 200);
  assert.equal(result.operation.displayCommand, exact);
  assert.equal(result.operation.cwdBefore, join(project.root, 'tools'));
  assert.equal((await fetch(`${base}/operations/terminal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: shell.id, command: exact, cwd: '..' }),
  })).status, 400);
});

test('HUD server serializes typed operations and exposes bounded evidence, live reads, and media', async (t) => {
  const project = await fixtureProject();
  await searchRepository(project, 'RIFF', 'media');
  const running = await startHudServer(project, { port: 0 });
  t.after(() => new Promise((resolveClose) => running.server.close(resolveClose)));
  const base = `http://127.0.0.1:${running.port}`;

  const stateResponse = await fetch(`${base}/state`);
  assert.equal(stateResponse.status, 200);
  assert.match(stateResponse.headers.get('content-type'), /application\/json/);
  const state = await stateResponse.json();
  assert.equal(state.project.id, 'indrolend/data');
  assert.equal(state.lastOperation.type, 'search');
  assert.deepEqual(state.lastOperation.files, [{ path: 'media/tone.wav', count: 1, lines: [1] }]);
  assert.ok(state.repository.root.directories.some((directory) => directory.path === 'media'));

  const handoffResponse = await fetch(`${base}/handoff`);
  assert.equal(handoffResponse.status, 200);
  const handoff = await handoffResponse.json();
  assert.equal(handoff.runId, state.last.runId);
  assert.match(handoff.handoff, new RegExp(`RAW run:${state.last.runId}`));
  assert.match(handoff.handoff, /media\/tone\.wav 1 lines=1/);

  const sourceResponse = await fetch(`${base}/source?path=${encodeURIComponent('media/tone.wav')}&context=0`);
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal(source.path, 'media/tone.wav');
  assert.equal(source.runId, state.last.runId);
  assert.equal(source.evidence, 'CURRENT');
  assert.deepEqual(source.excerpts, [{
    matchLine: 1, startLine: 1, endLine: 1,
    lines: [{ number: 1, text: 'RIFFtestWAVE', match: true }],
  }]);
  writeFileSync(join(project.root, 'media', 'tone.wav'), Buffer.from('RIFFchangedWAVE'));
  assert.equal((await (await fetch(`${base}/source?path=${encodeURIComponent('media/tone.wav')}&context=0`)).json()).evidence, 'STALE');
  writeFileSync(join(project.root, 'media', 'tone.wav'), Buffer.from('RIFFtestWAVE'));
  assert.equal((await fetch(`${base}/source?path=${encodeURIComponent('media/clip.mp4')}`)).status, 409);
  assert.equal((await fetch(`${base}/source?path=../secret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/source?path=${encodeURIComponent('media/tone.wav')}&context=20`)).status, 400);

  const treeResponse = await fetch(`${base}/tree`);
  assert.equal(treeResponse.status, 200);
  assert.equal((await treeResponse.json()).fileCount, 6);

  const indexResponse = await fetch(`${base}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get('content-type'), /text\/html/);

  const mediaResponse = await fetch(`${base}/media?path=${encodeURIComponent('media/tone.mp3')}`, {
    headers: { Range: 'bytes=0-2' },
  });
  assert.equal(mediaResponse.status, 206);
  assert.equal(mediaResponse.headers.get('content-type'), 'audio/mpeg');
  assert.equal(mediaResponse.headers.get('content-range'), 'bytes 0-2/8');
  assert.deepEqual([...new Uint8Array(await mediaResponse.arrayBuffer())], [0x49, 0x44, 0x33]);

  for (const [path, contentType] of [
    ['media/tone.wav', 'audio/wav'],
    ['media/clip.mp4', 'video/mp4'],
    ['media/clip.mov', 'video/quicktime'],
  ]) {
    const response = await fetch(`${base}/media?path=${encodeURIComponent(path)}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
  }

  assert.equal((await fetch(`${base}/media?path=../secret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/state`, { method: 'POST' })).status, 405);

  const searchResponse = await fetch(`${base}/operations/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'RIFF', scope: 'media' }),
  });
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.status, 'pass');
  assert.equal(search.operation.command, 'rg -n --no-heading --color never --fixed-strings -- RIFF media');
  assert.deepEqual(search.operation.files, [{ path: 'media/tone.wav', count: 1, lines: [1] }]);
  assert.equal(search.state.last.runId, search.runId);
  assert.deepEqual(search.state.lastOperation, search.operation);

  const zeroResponse = await fetch(`${base}/operations/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'not-present', scope: 'media' }),
  });
  const zero = await zeroResponse.json();
  assert.equal(zeroResponse.status, 200);
  assert.equal(zero.operation.exitCode, 1);
  assert.equal(zero.operation.matchCount, 0);

  const runBeforeInvalid = (await (await fetch(`${base}/state`)).json()).last.runId;
  for (const body of [
    { query: '', scope: 'media' },
    { query: 'RIFF', scope: '../outside' },
    { query: 'RIFF', scope: 'media', executable: 'powershell' },
  ]) {
    const invalid = await fetch(`${base}/operations/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }
  const wrongType = await fetch(`${base}/operations/search`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ query: 'RIFF', scope: 'media' }),
  });
  assert.equal(wrongType.status, 415);
  const crossOrigin = await fetch(`${base}/operations/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' },
    body: JSON.stringify({ query: 'RIFF', scope: 'media' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await (await fetch(`${base}/state`)).json()).last.runId, runBeforeInvalid);

  const commandRequest = fetch(`${base}/operations/repository-command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'native-tests' }),
  });
  const runtimeBusy = await waitForActiveRun(base);
  assert.equal(runtimeBusy.busy.type, 'repository-command');
  assert.equal(runtimeBusy.busy.label, 'native-tests');
  assert.ok(runtimeBusy.busy.runId);
  const activeEvidence = await waitForActiveEvidence(base, runtimeBusy.busy.runId, /STARTED/);
  assert.equal(activeEvidence.runId, runtimeBusy.busy.runId);
  assert.match(activeEvidence.text, /STARTED/);
  const blockedByBusy = await fetch(`${base}/operations/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'RIFF', scope: 'media' }),
  });
  assert.equal(blockedByBusy.status, 409);
  assert.equal((await blockedByBusy.json()).busy.type, 'repository-command');
  const commandResponse = await commandRequest;
  assert.equal(commandResponse.status, 200);
  const command = await commandResponse.json();
  assert.equal(command.status, 'pass');
  assert.equal(command.operation.type, 'repository-command');
  assert.equal(command.operation.name, 'native-tests');
  assert.deepEqual(command.operation.summary, ['2/2 CTest']);
  assert.equal(command.state.last.runId, command.runId);
  assert.deepEqual(command.state.lastOperation, command.operation);
  assert.equal((await (await fetch(`${base}/runtime`)).json()).busy, null);

  const commandRunId = command.runId;
  for (const body of [{ name: '' }, { name: 'not-declared' }, { name: 'native-tests', command: 'powershell' }]) {
    const invalid = await fetch(`${base}/operations/repository-command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }
  assert.equal((await (await fetch(`${base}/state`)).json()).last.runId, commandRunId);

  const historyResponse = await fetch(`${base}/history?limit=3`);
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()).history;
  assert.equal(history.length, 3);
  assert.equal(history[0].runId, commandRunId);
  assert.equal(history[0].type, 'repository-command');
  assert.equal(history[0].result, '2/2 CTest');
  assert.equal(history[1].type, 'search');
  const detailResponse = await fetch(`${base}/history/${search.runId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.deepEqual(detail.operation, search.operation);
  assert.match(detail.handoff, new RegExp(`RAW run:${search.runId}`));
  assert.equal((await fetch(`${base}/history/${search.runId}/handoff`)).status, 200);
  const stdoutEvidenceResponse = await fetch(`${base}/history/${commandRunId}/evidence/stdout?tail=3`);
  assert.equal(stdoutEvidenceResponse.status, 200);
  const stdoutEvidence = await stdoutEvidenceResponse.json();
  assert.equal(stdoutEvidence.complete, false);
  assert.ok(stdoutEvidence.size > 64 * 1024);
  assert.match(stdoutEvidence.text, /100% tests passed/);
  assert.ok(stdoutEvidence.returnedBytes < 64 * 1024);
  const stderrEvidence = await (await fetch(`${base}/history/${commandRunId}/evidence/stderr?tail=10`)).json();
  assert.equal(stderrEvidence.complete, true);
  assert.equal(stderrEvidence.size, 0);
  assert.equal((await fetch(`${base}/history/${commandRunId}/evidence/stdout?tail=501`)).status, 400);
  assert.equal((await fetch(`${base}/history/not-a-run/evidence/stdout`)).status, 404);
  assert.equal((await fetch(`${base}/history/not-a-run`)).status, 404);
  assert.equal((await fetch(`${base}/history?limit=0`)).status, 400);
  const historicalSource = await fetch(`${base}/source?path=${encodeURIComponent('media/tone.wav')}&context=0&run=${search.runId}`);
  assert.equal(historicalSource.status, 200);
  assert.equal((await historicalSource.json()).runId, search.runId);

  const undoPreview = await (await fetch(`${base}/undo/${commandRunId}`)).json();
  assert.equal(undoPreview.state, 'SAFE');
  assert.deepEqual(undoPreview.paths, ['media/generated.txt']);
  const undoResponse = await fetch(`${base}/operations/undo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: commandRunId }),
  });
  assert.equal(undoResponse.status, 200);
  const undo = await undoResponse.json();
  assert.equal(undo.operation.type, 'undo');
  assert.equal(undo.operation.targetRunId, commandRunId);
  assert.equal(existsSync(join(project.root, 'media', 'generated.txt')), false);
  assert.equal((await (await fetch(`${base}/undo/${commandRunId}`)).json()).state, 'CONFLICT');
  const repeatedUndo = await fetch(`${base}/operations/undo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: commandRunId }),
  });
  assert.equal(repeatedUndo.status, 409);
  assert.equal((await fetch(`${base}/undo/not-a-run`)).status, 404);

  const cancellableRequest = fetch(`${base}/operations/repository-command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'native-tests' }),
  });
  const cancellingRuntime = await waitForActiveRun(base);
  assert.equal(cancellingRuntime.busy.state, 'running');
  const cancelResponse = await fetch(`${base}/operations/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: cancellingRuntime.busy.runId }),
  });
  assert.equal(cancelResponse.status, 202);
  assert.equal((await cancelResponse.json()).status, 'cancelling');
  const cancelledResponse = await cancellableRequest;
  assert.equal(cancelledResponse.status, 200);
  const cancelled = await cancelledResponse.json();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.operation.status, 'cancelled');
  assert.equal(existsSync(join(project.root, 'media', 'generated.txt')), true);
  assert.equal((await (await fetch(`${base}/runtime`)).json()).busy, null);
  const undoCancelled = await fetch(`${base}/operations/undo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: cancelled.runId }),
  });
  assert.equal(undoCancelled.status, 200);
  assert.equal(existsSync(join(project.root, 'media', 'generated.txt')), false);
  const staleCancel = await fetch(`${base}/operations/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: cancelled.runId }),
  });
  assert.equal(staleCancel.status, 409);
});
