import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(dirname(fileURLToPath(import.meta.url)), 'visual-prototype');

test('visual HUD exposes one main menu over one command directory', () => {
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  const app = readFileSync(join(directory, 'app.js'), 'utf8');
  assert.equal((html.match(/id="toolkitButton"/g) || []).length, 1);
  assert.match(html, /aria-label="Open main HUD menu"/);
  assert.match(html, /aria-label="Main HUD menu"/);
  assert.doesNotMatch(html, /id="(?:categories|undoButton|historyButton|refreshState)"/);
  assert.match(app, /HUD: \[/);
  assert.match(app, /'undo'\]/);
  assert.match(app, /'history'\]/);
  assert.match(app, /'refresh'\]/);
  assert.match(app, /Commands ·/);
  assert.doesNotMatch(app, /Library ·/);
  assert.match(app, /openMenuSections = new Set\(\['HUD'\]\)/);
  assert.match(app, /dataset\.section/);
  assert.match(app, /new EventSource\('\/events'\)/);
  assert.match(app, /'\/session\/navigation'/);
  assert.match(app, /synchronizeState/);
});
