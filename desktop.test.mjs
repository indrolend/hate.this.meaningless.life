import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDesktopLock, findDesktopBrowser, startDesktopHud } from './desktop.mjs';

function fixtureProject() {
  const store = mkdtempSync(join(tmpdir(), 'hud-desktop-'));
  return { store, key: 'indrolend_data', root: join(store, 'repo') };
}

test('desktop lock is single-instance, owner-checked, and stale-safe', () => {
  const project = fixtureProject();
  const first = acquireDesktopLock(project);
  assert.equal(existsSync(first.path), true);
  assert.throws(() => acquireDesktopLock(project), /already active/);
  first.release();
  assert.equal(existsSync(first.path), false);

  mkdirSync(join(project.store, 'desktop'), { recursive: true });
  writeFileSync(first.path, JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const replacement = acquireDesktopLock(project);
  assert.equal(existsSync(replacement.path), true);
  replacement.release();
});

test('desktop host owns server and app-window lifetime', async () => {
  const project = fixtureProject();
  let serverClosed = 0;
  let launched = null;
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  const serverFactory = async () => ({
    host: '127.0.0.1', port: 54321, recovery: { recovered: [], detached: [], corrupt: [] },
    server: { close(callback) { serverClosed++; callback(); } },
  });
  const spawnImpl = (executable, args, options) => {
    launched = { executable, args, options };
    return child;
  };

  const desktop = await startDesktopHud(project, { browserPath: 'browser.exe', spawnImpl, serverFactory });
  assert.equal(desktop.url, 'http://127.0.0.1:54321/');
  assert.equal(launched.executable, 'browser.exe');
  assert.ok(launched.args.includes('--app=http://127.0.0.1:54321/'));
  assert.ok(launched.args.some((value) => value.startsWith('--user-data-dir=')));
  assert.throws(() => acquireDesktopLock(project), /already active/);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.deepEqual(await desktop.wait(), { code: 0, signal: null });
  assert.equal(serverClosed, 1);
  assert.equal(existsSync(join(project.store, 'desktop', `${project.key}.lock.json`)), false);
});

test('desktop browser discovery prefers an installed app-mode host', () => {
  const edge = join('C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const found = findDesktopBrowser({
    platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' },
    exists: (path) => path === edge,
  });
  assert.equal(found, edge);
});
