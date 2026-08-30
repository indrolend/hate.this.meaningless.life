import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

test('repository root is the only package installation authority', () => {
  const productRoot = resolve(import.meta.dirname, '..', '..');
  const product = JSON.parse(readFileSync(join(productRoot, 'package.json'), 'utf8'));
  const runtime = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
  assert.deepEqual(product.bin, {
    hud: './packages/commandhud/cli.mjs',
    commandhud: './packages/commandhud/cli.mjs',
  });
  assert.equal(runtime.bin, undefined);
});

test('a local product clone installs one portable hud command that attaches to another repository', () => {
  const productRoot = resolve(import.meta.dirname, '..', '..');
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-install-'));
  const prefix = join(temporary, 'prefix');
  const repository = join(temporary, 'fixture');
  const state = join(temporary, 'state');
  const hud = process.platform === 'win32' ? join(prefix, 'hud.ps1') : join(prefix, 'bin', 'hud');

  try {
    execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'commandhud@example.invalid'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'CommandHUD Test'], { cwd: repository });
    writeFileSync(join(repository, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'pipe' });

    const windowsNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const installer = process.platform === 'win32' && existsSync(windowsNpmCli)
      ? [process.execPath, [windowsNpmCli]]
      : ['npm', []];
    execFileSync(installer[0], [...installer[1], 'install', '--global', '--prefix', prefix, productRoot], {
      cwd: temporary, stdio: 'pipe', timeout: 30_000,
    });
    const invocation = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hud]]
      : [hud, []];
    const result = spawnSync(invocation[0], [...invocation[1], 'state', '--json', '--root', repository], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, HUD_STATE_ROOT: state },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.project.root, repository);
    assert.equal(value.git.branch, 'main');
    assert.equal(value.git.dirty, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
