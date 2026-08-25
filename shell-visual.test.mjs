import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellVisualStatus, particleMorphFrames, visualMotionEnabled } from './shell-visual.mjs';

test('terminal particle morph deterministically retains factual endpoints', () => {
  const frames = particleMorphFrames('RUNNING', 'PASS');
  assert.equal(frames[0].trim(), 'RUNNING');
  assert.equal(frames.at(-1).trim(), 'PASS');
  assert.equal(new Set(frames.map((frame) => frame.length)).size, 1);
  assert.match(frames[2], /[⠂⠒⠤⠲⠴⠦⠖⠶]/);
});

test('terminal motion respects interaction and reduced-motion boundaries', () => {
  assert.equal(visualMotionEnabled({ interactive: true, env: {} }), true);
  assert.equal(visualMotionEnabled({ interactive: false, env: {} }), false);
  assert.equal(visualMotionEnabled({ interactive: true, env: { COMMANDHUD_REDUCED_MOTION: '1' } }), false);
  assert.equal(visualMotionEnabled({ interactive: true, requested: false, env: {} }), false);
});

test('disabled visual status produces no terminal control output', async () => {
  let value = '';
  const status = createShellVisualStatus({ write: (text) => { value += text; } }, { enabled: false });
  status.start('echo OK');
  await status.finish('pass');
  assert.equal(value, '');
});

test('enabled visual status animates one replaceable row to a factual result', async () => {
  let value = '';
  const status = createShellVisualStatus({ write: (text) => { value += text; } }, { enabled: true, frameMs: 1 });
  status.start('npm run hud:test');
  await new Promise((resolve) => setTimeout(resolve, 3));
  await status.finish('pass');
  assert.match(value, /\r\x1b\[2K\(o_o\) RUNNING/);
  assert.match(value, /\(\^_\^\) PASS\s+· npm run hud:test\n$/);
  assert.doesNotMatch(value, /FAIL|STOPPED/);
});

test('reduced-motion visual status still updates its fixed row factually', async () => {
  let value = '';
  const status = createShellVisualStatus({ write: (text) => { value += text; } }, { enabled: true, animated: false, row: 2 });
  status.start('npm test');
  await status.finish('fail');
  assert.match(value, /\(o_o\) RUNNING/);
  assert.match(value, /\(x_x\) FAIL/);
  assert.doesNotMatch(value, /[⠂⠒⠤⠲⠴⠦⠖⠶]/);
});
