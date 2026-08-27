import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('hud impact human and JSON views inspect one retained record without creating a run', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-impact-cli-'));
  const state = join(temporary, 'state');
  const root = join(temporary, 'repo');
  mkdirSync(join(root, 'distribution'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'file.txt'), 'initial\n');
  writeFileSync(join(root, 'distribution', 'project.json'), JSON.stringify({
    id: 'fixture/impact-cli', commandHud: { commands: [{
      name: 'verify', command: 'node verify', argv: [process.execPath, '-e', "console.log('VERIFY_STAGE=PASS name=source'); console.log('VERIFY=PASS')"],
      resultMarkers: true, stageMarker: 'VERIFY_STAGE', stages: [{ name: 'source', paths: ['src'] }],
    }] },
  }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  const run = (args) => spawnSync(process.execPath, [cli, ...args, '--root', root], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HUD_STATE_ROOT: state },
  });
  try {
    const recorded = run(['repository-command', 'verify', '--json', '--quiet']);
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    const runId = JSON.parse(recorded.stdout).runId;
    const runsRoot = join(state, 'runs', 'fixture_impact-cli');
    const countBefore = readdirSync(runsRoot).length;
    const json = run(['impact', 'verify', '--json']);
    const human = run(['impact', 'verify']);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.equal(human.status, 0, human.stderr || human.stdout);
    const value = JSON.parse(json.stdout);
    assert.equal(value.runId, runId);
    assert.equal(value.state, 'CURRENT');
    assert.equal(value.stages[0].state, 'CURRENT');
    assert.match(human.stdout, new RegExp(`IMPACT verify[\\s\\S]*RUN ${runId}[\\s\\S]*source PASS CURRENT[\\s\\S]*RAW run:${runId}`));
    assert.equal(readdirSync(runsRoot).length, countBefore);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
