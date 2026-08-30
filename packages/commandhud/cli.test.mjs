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

test('client routes reject unknown, missing, irrelevant, and positional arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'commandhud-client-route-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root, stdio: 'pipe' });
    const run = (args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    const unknown = run(['state', '--definitely-unknown']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown hud option: --definitely-unknown/);

    const missing = run(['state', '--root']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--root requires a value/);

    const irrelevant = run(['desktop', '--tui']);
    assert.notEqual(irrelevant.status, 0);
    assert.match(irrelevant.stderr, /hud desktop does not support --tui/);

    const positional = run(['shell', 'desktop']);
    assert.notEqual(positional.status, 0);
    assert.match(positional.stderr, /hud shell accepts at most 0 positional arguments/);

    const ignoredPositional = run(['state', 'unexpected']);
    assert.notEqual(ignoredPositional.status, 0);
    assert.match(ignoredPositional.stderr, /hud state accepts at most 0 positional arguments/);

    const runOption = run(['run', '--json', '--bad']);
    assert.notEqual(runOption.status, 0);
    assert.match(runOption.stderr, /Unknown hud option: --bad/);

    const orphanedWorkflow = run(['run', '--stage', 'test', '--', process.execPath, '-e', '']);
    assert.notEqual(orphanedWorkflow.status, 0);
    assert.match(orphanedWorkflow.stderr, /workflow details require --workflow-id/);

    const conflictingRequest = run(['run', '--request', 'text', '--request-b64', 'dGV4dA==', '--', process.execPath, '-e', '']);
    assert.notEqual(conflictingRequest.status, 0);
    assert.match(conflictingRequest.stderr, /either --request or --request-b64/);

    const ignoredCopy = run(['handoff', '--copy', '--json']);
    assert.notEqual(ignoredCopy.status, 0);
    assert.match(ignoredCopy.stderr, /does not combine --copy with --json/);

    const wrongLayer = run(['state', '--host', '127.0.0.1']);
    assert.notEqual(wrongLayer.status, 0);
    assert.match(wrongLayer.stderr, /hud state does not support --host/);

    const selectedRoot = run(['state', '--json', '--root', root]);
    assert.equal(selectedRoot.status, 0, selectedRoot.stderr || selectedRoot.stdout);
    assert.equal(JSON.parse(selectedRoot.stdout).project.root, root);

    const clear = run(['objective', '--clear', '--root', root]);
    assert.equal(clear.status, 0, clear.stderr || clear.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hud run JSON is pure for passing and failing commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'commandhud-json-route-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root, stdio: 'pipe' });
    const run = (script) => spawnSync(process.execPath, [cli, 'run', '--json', '--', process.execPath, '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') },
    });
    const passing = spawnSync(process.execPath, [cli, 'run', '--json', '--workflow-id', 'verify', '--workflow-name', 'verify JSON', '--stage', 'test', '--stage-index', '1', '--stage-count', '1', '--', process.execPath, '-e', "console.log('not-before-json')"], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') },
    });
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(JSON.parse(passing.stdout).status, 'pass');
    assert.doesNotMatch(passing.stdout, /^not-before-json/m);

    const failing = run("console.error('not-before-json'); process.exit(7)");
    assert.equal(failing.status, 1, failing.stderr);
    assert.equal(JSON.parse(failing.stdout).status, 'fail');
    assert.doesNotMatch(failing.stdout, /^not-before-json/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('hud storage human and JSON views inspect all retained projects without creating a run', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'commandhud-storage-cli-'));
  const state = join(temporary, 'state');
  const root = join(temporary, 'repo');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'file.txt'), 'fixture\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  const run = (args) => spawnSync(process.execPath, [cli, ...args, '--root', root], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HUD_STATE_ROOT: state },
  });
  try {
    const recorded = spawnSync(process.execPath, [cli, 'run', '--json', '--quiet', '--root', root, '--', process.execPath, '-e', 'console.log("stored")'], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HUD_STATE_ROOT: state },
    });
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    assert.equal(JSON.parse(recorded.stdout).status, 'pass');
    const runsRoot = join(state, 'runs');
    const countRuns = () => readdirSync(runsRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name === 'run.json').length;
    const countBefore = countRuns();
    const json = run(['storage', '--json']);
    const human = run(['storage']);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.equal(human.status, 0, human.stderr || human.stdout);
    const value = JSON.parse(json.stdout);
    assert.equal(value.runCount, 1);
    assert.equal(value.integrity.VERIFIED, 1);
    assert.match(human.stdout, /COMMANDHUD_STORAGE[\s\S]*runs=1[\s\S]*INTEGRITY VERIFIED=1/);
    assert.equal(countRuns(), countBefore);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
