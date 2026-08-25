import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellLayout, fitPanelLines, footerActionAt, splitMouseInput } from './shell-layout.mjs';

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
  layout.placePrompt('powershell .> ');
  layout.finish();
  assert.match(value, /\x1b\[\?1049h/);
  assert.match(value, /\x1b\[1;1H.*hate\.this\.meaningless\.life/);
  assert.match(value, /\x1b\[6;1H.*PASS/);
  assert.match(value, /\x1b\[4;1H.*powershell/);
  assert.match(value, /\x1b\[\?1049l/);
});

test('terminal footer highlights only its hovered action', () => {
  let value = '';
  const output = { columns: 80, rows: 24, write: (text) => { value += text; }, on() {}, off() {} };
  const layout = createShellLayout(output);
  layout.start();
  value = '';
  layout.setHover('/copy');
  assert.match(value, /\x1b\[7m\[ COPY OUTPUT \]\x1b\[27m/);
  assert.doesNotMatch(value, /\x1b\[7m\[ RAW \]/);
  layout.setHover(null);
  assert.match(value, /\[ COPY OUTPUT \]/);
  layout.finish();
});

test('terminal footer exposes bounded mouse actions without executable text', () => {
  assert.equal(footerActionAt(19), '/copy');
  assert.equal(footerActionAt(35), '/raw');
  assert.equal(footerActionAt(43), '/undo');
  assert.equal(footerActionAt(52), '/help');
  assert.equal(footerActionAt(61), '/exit');
  assert.equal(footerActionAt(1), null);
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
