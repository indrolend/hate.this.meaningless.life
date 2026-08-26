import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
