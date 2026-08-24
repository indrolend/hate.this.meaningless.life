import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProject } from './core.mjs';
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

test('read-only HUD server exposes live state, tree, static UI, and byte-range media', async (t) => {
  const project = await fixtureProject();
  const running = await startHudServer(project, { port: 0 });
  t.after(() => new Promise((resolveClose) => running.server.close(resolveClose)));
  const base = `http://127.0.0.1:${running.port}`;

  const stateResponse = await fetch(`${base}/state`);
  assert.equal(stateResponse.status, 200);
  assert.match(stateResponse.headers.get('content-type'), /application\/json/);
  const state = await stateResponse.json();
  assert.equal(state.project.id, 'indrolend/data');
  assert.ok(state.repository.root.directories.some((directory) => directory.path === 'media'));

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
});
