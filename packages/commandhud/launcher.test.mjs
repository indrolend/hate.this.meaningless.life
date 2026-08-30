import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const productRoot = resolve(import.meta.dirname, '..', '..');

function captureLauncher(name, args, { powershell = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-launcher-argv-'));
  const output = join(temporary, 'argv.json');
  const preload = join(temporary, 'capture.cjs');
  const launcher = join(productRoot, name);
  writeFileSync(preload, `require('node:fs').writeFileSync(process.env.COMMANDHUD_ARGV_CAPTURE, JSON.stringify(process.argv.slice(1)));process.exit(0);\n`);
  const env = { ...process.env, NODE_OPTIONS: `--require=${preload}`, COMMANDHUD_ARGV_CAPTURE: output };
  const quotePowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const invocation = powershell
    ? ['powershell.exe', ['-NoProfile', '-Command', `& ${[launcher, ...args].map(quotePowerShell).join(' ')}`]]
    : ['cmd.exe', ['/d', '/c', launcher, ...args]];
  try {
    const result = spawnSync(invocation[0], invocation[1], { cwd: temporary, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('Windows launchers select explicit clients and preserve caller arguments', {
  skip: process.platform !== 'win32',
}, () => {
  const selectedRoot = 'C:\\target repository with spaces';
  const tui = captureLauncher('CommandHUD-TUI.cmd', ['--root', selectedRoot, '--no-animation']);
  assert.deepEqual(tui.slice(1), ['shell', '--root', selectedRoot, '--no-animation', '--tui']);

  const desktop = captureLauncher('CommandHUD-Desktop.cmd', ['--root', selectedRoot]);
  assert.deepEqual(desktop.slice(1), ['desktop', '--root', selectedRoot]);

  const router = captureLauncher('CommandHUD.cmd', ['tui', '--root', selectedRoot]);
  assert.deepEqual(router.slice(1), ['tui', '--root', selectedRoot]);

  const compatibility = captureLauncher('CommandHUD Shell.cmd', ['--root', selectedRoot, '--tui'], { powershell: true });
  assert.deepEqual(compatibility.slice(1), ['shell', '--root', selectedRoot, '--tui']);
});

test('Windows compatibility launcher matches the no-argument CLI context route', {
  skip: process.platform !== 'win32',
}, () => {
  const result = spawnSync('cmd.exe', ['/d', '/c', join(productRoot, 'CommandHUD.cmd')], {
    cwd: productRoot, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PROJECT=indrolend\/hate\.this\.meaningless\.life/);
});
