import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dirname, 'cli.mjs');

for (const command of ['help', '--help', '-h']) {
  test(`hud ${command} is available outside a repository`, () => {
    const outside = mkdtempSync(join(tmpdir(), 'commandhud-help-'));
    try {
      const result = spawnSync(process.execPath, [cli, command], {
        cwd: outside, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /hate\.this\.meaningless\.life · context condenser/);
      assert.match(result.stdout, /hud shell/);
      assert.match(result.stdout, /Retained evidence \(never reruns the command\)/);
      assert.match(result.stdout, /hud undo-plan <run>/);
      assert.doesNotMatch(result.stderr, /No Git repository/);
      assert.ok(result.stdout.trimEnd().split(/\r?\n/).length < 40);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test('hud runtime uses scriptable exit status for current and stale source authority', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-runtime-cli-'));
  const state = join(temporary, 'state');
  const source = join(temporary, 'source');
  const sourceCli = join(source, 'packages', 'commandhud', 'cli.mjs');
  mkdirSync(join(state, 'projects'), { recursive: true });
  mkdirSync(join(source, 'packages', 'commandhud'), { recursive: true });
  copyFileSync(cli, sourceCli);
  writeFileSync(join(state, 'projects', 'product.json'), JSON.stringify({
    id: 'indrolend/hate.this.meaningless.life', root: source,
  }));
  const run = () => spawnSync(process.execPath, [cli, 'runtime', '--json'], {
    cwd: temporary, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HUD_STATE_ROOT: state },
  });
  try {
    const current = run();
    assert.equal(current.status, 0, current.stderr || current.stdout);
    assert.equal(JSON.parse(current.stdout).status, 'CURRENT');
    writeFileSync(sourceCli, 'stale source bytes');
    const stale = run();
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    assert.equal(JSON.parse(stale.stdout).status, 'STALE');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
