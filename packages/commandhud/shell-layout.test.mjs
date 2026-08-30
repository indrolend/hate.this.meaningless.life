import test from 'node:test';
import assert from 'node:assert/strict';
import { clipAnsi, createShellLayout, fitPanelLines, footerActionAt, splitMouseInput, visibleWidth } from './shell-layout.mjs';

test('fixed terminal panel preserves useful head and raw reference when bounded', () => {
  const input = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
  const lines = fitPanelLines(input, 40, 8);
  assert.equal(lines.length, 8);
  assert.equal(lines[0], 'line 1');
  assert.match(lines[5], /lines hidden/);
  assert.equal(lines.at(-1), 'line 20');
});

test('fixed terminal layout uses alternate screen and stable top and bottom regions', () => {
  let value = '';
  const output = { columns: 60, rows: 20, write: (text) => { value += text; }, on() {}, off() {} };
  const layout = createShellLayout(output);
  layout.start();
  layout.renderOutput('PASS\nSHORTENED OUTPUT\nOK');
  layout.placePrompt();
  layout.finish();
  assert.match(value, /\x1b\[\?1049h/);
  assert.match(value, /\x1b\[1;1H.*hate\.this\.meaningless\.life/);
  assert.match(value, /\x1b7\x1b\[6;1H.*PASS/);
  assert.match(value, /\x1b\[4;1H\x1b\[2K/);
  assert.match(value, /\x1b\[\?1049l/);
});

test('terminal footer highlights only its hovered action', () => {
  let value = '';
  const output = { columns: 80, rows: 24, write: (text) => { value += text; }, on() {}, off() {} };
  const layout = createShellLayout(output);
  layout.start();
  value = '';
  layout.setHover('copy');
  assert.match(value, /\x1b\[7m\[ COPY OUTPUT \]\x1b\[27m/);
  assert.doesNotMatch(value, /\x1b\[7m\[ RAW \]/);
  layout.setHover(null);
  assert.match(value, /\[ COPY OUTPUT \]/);
  layout.finish();
});

test('terminal footer exposes bounded mouse actions without executable text', () => {
  assert.equal(footerActionAt(19), 'copy');
  assert.equal(footerActionAt(35), 'raw');
  assert.equal(footerActionAt(43), 'undo');
  assert.equal(footerActionAt(52), 'help');
  assert.equal(footerActionAt(61), 'exit');
  assert.equal(footerActionAt(1), null);
});

test('terminal controls maintain explicit keyboard focus separate from hover', () => {
  let value = '';
  const output = { columns: 100, rows: 24, write: (text) => { value += text; }, on() {}, off() {} };
  const layout = createShellLayout(output);
  layout.start();
  value = '';
  assert.equal(layout.moveFocus(1), 'copy');
  assert.equal(layout.moveFocus(1), 'raw');
  assert.equal(layout.moveFocus(-1), 'copy');
  layout.setHover('help');
  assert.equal(layout.focusedAction, 'copy');
  assert.match(value, /\x1b\[1;7m\[ COPY OUTPUT \]\x1b\[0m/);
  assert.match(value, /\x1b\[7m\[ HELP \]\x1b\[27m/);
  layout.setFocus(null);
  assert.equal(layout.focusedAction, null);
  layout.finish();
});

test('ANSI footer styling clips by visible columns without changing hitbox geometry', () => {
  const styled = '\x1b[7m[ COPY OUTPUT ]\x1b[27m [ RAW ]';
  const clipped = clipAnsi(styled, 18);
  assert.equal(visibleWidth(clipped), 18);
  assert.match(clipped, /\x1b\[7m/);
  assert.equal(footerActionAt(19), 'copy');
  assert.equal(footerActionAt(35), 'raw');
});

test('resize and repeated hover redraw fixed controls only at their absolute rows', () => {
  const writes = [];
  let resize;
  const output = { columns: 80, rows: 24, write: (text) => { writes.push(text); }, on(name, fn) { if (name === 'resize') resize = fn; }, off() {} };
  const layout = createShellLayout(output);
  layout.start();
  writes.length = 0;
  layout.setHover('copy');
  layout.setHover('raw');
  output.rows = 30;
  resize();
  const footerWrites = writes.filter((value) => /\x1b\[(?:24|30);1H\x1b\[2K/.test(value));
  assert.ok(footerWrites.length >= 3);
  assert.ok(footerWrites.every((value) => /\x1b\[(?:24|30);1H\x1b\[2K/.test(value)));
  layout.finish();
});

test('mouse protocol is removed before command input while real typing survives', () => {
  const parsed = splitMouseInput(`git status\x1b[<35;19;22M\x1b[<0;19;22M\x1b[<0;19;22m`);
  assert.equal(parsed.text, 'git status');
  assert.deepEqual(parsed.events, [
    { button: 35, column: 19, row: 22, phase: 'M' },
    { button: 0, column: 19, row: 22, phase: 'M' },
    { button: 0, column: 19, row: 22, phase: 'm' },
  ]);
});
