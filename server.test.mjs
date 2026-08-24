import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProject, searchRepository } from './core.mjs';
import { startHudServer } from './server.mjs';

function fixtureProject() {
  const root = mkdtempSync(join(tmpdir(), 'hud-server-'));
  mkdirSync(join(root, 'distribution'));
  mkdirSync(join(root, 'media'));
  writeFileSync(join(root, 'distribution', 'project.json'), JSON.stringify({
    id: 'indrolend/data',
    channel: 'test',
    manifest: 'https://example.invalid/manifest.json',
  }));
  writeFileSync(join(root, 'media', 'tone.mp3'), Buffer.from([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]));
  writeFileSync(join(root, 'media', 'tone.wav'), Buffer.from('RIFFtestWAVE'));
  writeFileSync(join(root, 'media', 'clip.mp4'), Buffer.from('test-mp4'));
  writeFileSync(join(root, 'media', 'clip.mov'), Buffer.from('test-mov'));
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

test('HUD server exposes live reads, typed Search, and byte-range media without arbitrary execution', async (t) => {
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
  assert.equal((await treeResponse.json()).fileCount, 5);

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
});
