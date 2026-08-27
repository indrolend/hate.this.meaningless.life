import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCurrentOperationContext, buildOperationContext, buildOperationHandoff, buildPacket, buildWindowsServiceResetPlan, buildWorkflowPacket, classifyEvidence, compareFilesystemFiles, continuation, currentState, diffRunEvidence, discoverCommands, discoverShells, fetchUpdate, filesystemIdentity, formatPacket, gitSnapshot, inspectRuntimeAuthority, operationDetail, operationHistory, parseResultMarkers, parseSearchOutput, parseWindowsServiceObservation, projectRunEvidence, readProjectState, recordFilesystemComparison, recoverInterruptedRuns, reduceOutput, repositoryCurrency, repositoryTree, resolveProject, runById, runCommand, runRepositoryCommand, runTerminalCommand, searchRepository, setWorkingValue, undoOperation, undoPlan, workingValue, workflowView } from './core.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hud-fixture-'));
  mkdirSync(join(root, 'distribution'));
  writeFileSync(join(root, 'distribution', 'project.json'), JSON.stringify({ id: 'indrolend/data', channel: 'latest-native', manifest: 'https://example.invalid/manifest.json' }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  writeFileSync(join(root, 'file.txt'), 'initial\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return root;
}

function fixtureProject() {
  const root = fixture();
  return resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'hud-state-')) } });
}

test('recorded evidence supports raw and bounded projections without rerunning', async () => {
  const project = await fixtureProject();
  const marker = join(project.root, 'projection-count.txt');
  const script = `const fs=require('node:fs');const p=${JSON.stringify(marker)};fs.writeFileSync(p,String((Number(fs.existsSync(p)&&fs.readFileSync(p,'utf8'))||0)+1));console.log('alpha');console.log('needle');console.log('omega');console.error('warning needle')`;
  const record = await runCommand(project, [process.execPath, '-e', script]);
  assert.equal(readFileSync(marker, 'utf8'), '1');

  const raw = projectRunEvidence(project, record.id);
  assert.match(raw.streams[0].content, /alpha\nneedle\nomega/);
  assert.match(raw.streams[1].content, /warning needle/);
  assert.equal(readFileSync(marker, 'utf8'), '1');

  assert.deepEqual(projectRunEvidence(project, record.id, { mode: 'head', count: 2 }).streams[0].lines, [
    { number: 1, text: 'alpha' }, { number: 2, text: 'needle' },
  ]);
  assert.deepEqual(projectRunEvidence(project, record.id, { mode: 'tail', count: 2 }).streams[0].lines, [
    { number: 2, text: 'needle' }, { number: 3, text: 'omega' },
  ]);
  assert.deepEqual(projectRunEvidence(project, record.id, { mode: 'find', pattern: 'needle' }).streams.map((stream) => ({
    stream: stream.stream, matches: stream.matchCount, lines: stream.lines,
  })), [
    { stream: 'stdout', matches: 1, lines: [{ number: 2, text: 'needle' }] },
    { stream: 'stderr', matches: 1, lines: [{ number: 1, text: 'warning needle' }] },
  ]);
  assert.deepEqual(projectRunEvidence(project, record.id, { mode: 'around', pattern: 'needle', context: 1 }).streams[0].lines, [
    { number: 1, text: 'alpha' }, { number: 2, text: 'needle' }, { number: 3, text: 'omega' },
  ]);
  assert.equal(readFileSync(marker, 'utf8'), '1');
});

test('recorded evidence projections reject missing runs and invalid requests', async () => {
  const project = await fixtureProject();
  assert.throws(() => projectRunEvidence(project, '20260101000000-abcd'), /No recorded run/);
  const record = await runCommand(project, [process.execPath, '-e', 'console.log("ok")']);
  assert.throws(() => projectRunEvidence(project, record.id, { mode: 'head', count: 0 }), /line count from 1 to 500/);
  assert.throws(() => projectRunEvidence(project, record.id, { mode: 'find', pattern: '' }), /non-empty pattern/);
  assert.throws(() => projectRunEvidence(project, record.id, { mode: 'different' }), /Unknown evidence projection/);
});

test('run evidence diff compares immutable streams without rerunning either command', async () => {
  const project = await fixtureProject();
  const counter = join(project.root, 'diff-counter.txt');
  const command = (value) => [process.execPath, '-e', `const fs=require('node:fs');const p=${JSON.stringify(counter)};fs.appendFileSync(p,'x');console.log(${JSON.stringify(value)});console.error('stable warning')`];
  const left = await runCommand(project, command('alpha'));
  const right = await runCommand(project, command('beta'));
  assert.equal(readFileSync(counter, 'utf8'), 'xx');
  const value = await diffRunEvidence(project, left.id, right.id);
  assert.equal(readFileSync(counter, 'utf8'), 'xx');
  assert.equal(value.different, true);
  assert.equal(value.streams[0].different, true);
  assert.match(value.streams[0].text, /-alpha/);
  assert.match(value.streams[0].text, /\+beta/);
  assert.doesNotMatch(value.streams[0].text, /CommandHud|stdout\.log/);
  assert.equal(value.streams[1].different, false);
  assert.equal(value.streams[1].text, '');
});

test('filesystem identity reports real bytes and file comparison avoids metadata guesses', () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-file-identity-'));
  const left = join(root, 'left.bin');
  const same = join(root, 'same.bin');
  const different = join(root, 'different.bin');
  writeFileSync(left, Buffer.from([0, 1, 2, 255]));
  writeFileSync(same, Buffer.from([0, 1, 2, 255]));
  writeFileSync(different, Buffer.from([0, 1, 3, 255]));

  const identity = filesystemIdentity('left.bin', { base: root });
  assert.equal(identity.path, left);
  assert.equal(identity.exists, true);
  assert.equal(identity.type, 'file');
  assert.equal(identity.size, 4);
  assert.match(identity.mtime, /^\d{4}-\d\d-\d\dT/);
  assert.match(identity.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(compareFilesystemFiles(left, same).status, 'identical');
  assert.equal(compareFilesystemFiles(left, same).sameBytes, true);
  assert.equal(compareFilesystemFiles(left, different).status, 'different');
  assert.equal(compareFilesystemFiles(left, different).sameBytes, false);
});

test('filesystem comparison reports missing and non-file inputs without claiming byte equality', () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-file-boundaries-'));
  const file = join(root, 'file.txt');
  writeFileSync(file, 'content');
  assert.deepEqual(filesystemIdentity('missing.txt', { base: root }), {
    path: join(root, 'missing.txt'), exists: false, type: 'missing', size: null, mtime: null, sha256: null,
  });
  assert.deepEqual(compareFilesystemFiles(file, join(root, 'missing.txt')).status, 'right-missing');
  assert.deepEqual(compareFilesystemFiles(join(root, 'one'), join(root, 'two')).status, 'both-missing');
  const directoryComparison = compareFilesystemFiles(root, file);
  assert.equal(directoryComparison.status, 'not-files');
  assert.equal(directoryComparison.sameBytes, null);
  assert.throws(() => filesystemIdentity(''), /valid path/);
});

test('runtime authority distinguishes current, stale, and project-local duplicate implementations', () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-runtime-authority-'));
  const state = join(root, 'state');
  const source = join(root, 'source');
  const installed = join(root, 'installed', 'node_modules', '@indrolend', 'hate-this-meaningless-life', 'packages', 'commandhud', 'cli.mjs');
  mkdirSync(join(source, 'packages', 'commandhud'), { recursive: true });
  mkdirSync(join(installed, '..'), { recursive: true });
  mkdirSync(join(state, 'projects'), { recursive: true });
  writeFileSync(join(source, 'packages', 'commandhud', 'cli.mjs'), 'same');
  writeFileSync(installed, 'same');
  writeFileSync(join(state, 'projects', 'product.json'), JSON.stringify({ id: 'indrolend/hate.this.meaningless.life', root: source }));
  const env = { ...process.env, HUD_STATE_ROOT: state };
  assert.equal(inspectRuntimeAuthority({ executingPath: installed, env }).status, 'CURRENT');
  writeFileSync(installed, 'older');
  assert.equal(inspectRuntimeAuthority({ executingPath: installed, env }).status, 'STALE');

  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, 'tools', 'hud'), { recursive: true });
  writeFileSync(join(projectRoot, 'tools', 'hud', 'cli.mjs'), 'copy');
  const duplicate = inspectRuntimeAuthority({
    executingPath: installed, env,
    project: { root: projectRoot, identity: { id: 'example/project' } },
  });
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(duplicate.projectCopies[0].path, 'tools/hud/cli.mjs');
});

test('filesystem comparison operation preserves exact identities and compact handoff in immutable evidence', async () => {
  const project = await fixtureProject();
  const left = join(project.root, 'left.bin');
  const right = join(project.root, 'right.bin');
  writeFileSync(left, 'same bytes');
  writeFileSync(right, 'same bytes');
  const record = await recordFilesystemComparison(project, 'left.bin', 'right.bin');
  assert.equal(record.status, 'pass');
  assert.equal(record.operation.type, 'filesystem-comparison');
  assert.equal(record.operation.comparison.status, 'identical');
  assert.equal(record.operation.comparison.sameBytes, true);
  assert.match(record.operation.comparison.left.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.operation.comparison.left.sha256, record.operation.comparison.right.sha256);
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /"status":"identical"/);
  assert.equal(readFileSync(record.stderrPath, 'utf8'), '');
  const handoff = buildOperationHandoff(project, record);
  assert.match(handoff, /BYTE_STATUS identical/);
  assert.match(handoff, /SAME_BYTES true/);
  assert.match(handoff, new RegExp(`RAW run:${record.id}`));
});

test('result markers parse only the narrow opted-in line grammar with factual provenance', () => {
  assert.deepEqual(parseResultMarkers(
    'noise\nASSET_MIRRORS=PASS count=7 target=native\nBAD=UNKNOWN value=1\nDUPLICATE=PASS x=1 x=2\n',
    'MULTIPLAYER_PARITY=FAIL room=alpha\n',
  ), [
    { event: 'ASSET_MIRRORS', status: 'PASS', fields: { count: '7', target: 'native' }, stream: 'stdout', line: 2, raw: 'ASSET_MIRRORS=PASS count=7 target=native' },
    { event: 'MULTIPLAYER_PARITY', status: 'FAIL', fields: { room: 'alpha' }, stream: 'stderr', line: 1, raw: 'MULTIPLAYER_PARITY=FAIL room=alpha' },
  ]);
  assert.deepEqual(reduceOutput('type source.txt', 'ASSET_MIRRORS=PASS count=7', '', 0).markers, []);
  assert.equal(reduceOutput('declared adapter', 'ASSET_MIRRORS=PASS count=7', '', 0, { resultMarkers: true }).markers.length, 1);
});

test('Windows service evidence parser validates and normalizes factual probe output', () => {
  assert.deepEqual(parseWindowsServiceObservation(JSON.stringify({
    name: 'Spooler', displayName: 'Print Spooler', status: 'Running', startType: 'Automatic',
    canStop: true, processId: 123, dependsOn: ['RPCSS'], dependents: ['VPDAgent', 'VPDAgent'],
  })), {
    name: 'Spooler', displayName: 'Print Spooler', status: 'Running', startType: 'Automatic',
    canStop: true, processId: 123, dependsOn: ['RPCSS'], dependents: ['VPDAgent'],
  });
  assert.throws(() => parseWindowsServiceObservation('not json'), /valid JSON/);
  assert.throws(() => parseWindowsServiceObservation('{"name":"Spooler"}'), /malformed evidence/);
});

test('Windows service reset plan stops running dependents first and restores only prior running state', () => {
  const service = (name, status, canStop, dependents = []) => ({
    name, displayName: name, status, startType: 'Automatic', canStop, processId: status === 'Running' ? 10 : 0,
    dependsOn: [], dependents,
  });
  assert.deepEqual(buildWindowsServiceResetPlan([
    service('Spooler', 'Running', true, ['Fax', 'VPDAgent']),
    service('Fax', 'Stopped', false),
    service('VPDAgent', 'Running', true, ['PrintMonitor']),
    service('PrintMonitor', 'Running', true),
  ], 'Spooler'), {
    target: 'Spooler', safe: true, blockers: [], missing: [],
    stop: ['PrintMonitor', 'VPDAgent', 'Spooler'],
    start: ['Spooler', 'VPDAgent', 'PrintMonitor'],
    observed: [
      service('Fax', 'Stopped', false), service('PrintMonitor', 'Running', true),
      service('Spooler', 'Running', true, ['Fax', 'VPDAgent']), service('VPDAgent', 'Running', true, ['PrintMonitor']),
    ],
  });
  const blocked = buildWindowsServiceResetPlan([service('Spooler', 'Running', true, ['Agent']), service('Agent', 'Running', false)], 'Spooler');
  assert.equal(blocked.safe, false);
  assert.deepEqual(blocked.blockers, ['Agent']);
  const incomplete = buildWindowsServiceResetPlan([service('Spooler', 'Running', true, ['UnknownAgent'])], 'Spooler');
  assert.equal(incomplete.safe, false);
  assert.deepEqual(incomplete.missing, ['UnknownAgent']);
});

test('repository command discovery derives a deterministic inspectable library', () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-commands-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs', build: 'node build.mjs' } }));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'run-native-tests.mjs'), '');
  writeFileSync(join(root, 'commandhud.project.json'), JSON.stringify({ id: 'fixture/commands', commandHud: { commands: [
    { name: 'native-tests', command: 'node tools/run-native-tests.mjs', argv: ['node', 'tools/run-native-tests.mjs'], owner: 'tools/run-native-tests.mjs', kind: 'test' },
  ] } }));
  assert.deepEqual(discoverCommands(root), [
    { name: 'npm:build', command: 'npm run build' },
    { name: 'npm:test', command: 'npm run test' },
    { name: 'native-tests', command: 'node tools/run-native-tests.mjs' },
  ]);
});

test('repository command declarations fail closed when malformed, duplicate, or escaping', () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-command-validation-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }));
  const identityPath = join(root, 'commandhud.project.json');
  const writeCommands = (commands) => writeFileSync(identityPath, JSON.stringify({ id: 'fixture/validation', commandHud: { commands } }));

  writeCommands([{ name: 'broken', command: '', argv: [] }]);
  assert.throws(() => discoverCommands(root), /Invalid CommandHUD command declaration/);

  writeCommands([{ name: 'marker', command: 'node marker.mjs', argv: ['node', 'marker.mjs'], successMarkers: [{ contains: '', summary: 'pass' }] }]);
  assert.throws(() => discoverCommands(root), /Invalid CommandHUD success marker declaration/);

  writeCommands([{ name: 'kind', command: 'node kind.mjs', argv: ['node', 'kind.mjs'], kind: 'build' }]);
  assert.throws(() => discoverCommands(root), /Invalid CommandHUD command kind/);

  writeCommands([{ name: 'markers', command: 'node markers.mjs', argv: ['node', 'markers.mjs'], resultMarkers: 'yes' }]);
  assert.throws(() => discoverCommands(root), /Invalid CommandHUD result marker declaration/);

  writeCommands([{ name: 'npm:test', command: 'node other.mjs', argv: ['node', 'other.mjs'] }]);
  assert.throws(() => discoverCommands(root), /Duplicate repository command identity/);

  writeCommands([{ name: 'escape', command: 'node outside.mjs', argv: ['node', 'outside.mjs'], owner: '../outside.mjs' }]);
  assert.throws(() => discoverCommands(root), /owner escapes the repository/);
});

test('repository command execution resolves a current discovered identity and records evidence', async () => {
  const root = fixture();
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'run-native-tests.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../file.txt", import.meta.url), "changed by command\\n"); console.log("100% tests passed, 0 tests failed out of 3"); console.log("NATIVE_TESTS=PASS count=3")\n');
  const identityPath = join(root, 'distribution', 'project.json');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  identity.commandHud = { commands: [{ name: 'native-tests', command: 'node tools/run-native-tests.mjs', argv: ['node', 'tools/run-native-tests.mjs'], owner: 'tools/run-native-tests.mjs', kind: 'test', resultMarkers: true }] };
  writeFileSync(identityPath, JSON.stringify(identity));
  execFileSync('git', ['add', 'tools/run-native-tests.mjs', 'distribution/project.json'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add command fixture'], { cwd: root });
  const project = await resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'hud-command-state-')) } });

  const record = await runRepositoryCommand(project, 'native-tests', { origin: 'cli-argv' });
  assert.equal(record.status, 'pass');
  assert.equal(record.operation.type, 'repository-command');
  assert.equal(record.operation.name, 'native-tests');
  assert.equal(record.operation.displayCommand, 'node tools/run-native-tests.mjs');
  assert.equal(record.operation.command, 'node tools/run-native-tests.mjs');
  assert.deepEqual(record.provenance, { origin: 'cli-argv', finalizedBy: 'process-exit' });
  assert.deepEqual(record.operation.provenance, record.provenance);
  assert.deepEqual(record.operation.summary, ['3/3 CTest']);
  assert.deepEqual(record.operation.markers, [{ event: 'NATIVE_TESTS', status: 'PASS', fields: { count: '3' }, stream: 'stdout', line: 2, raw: 'NATIVE_TESTS=PASS count=3' }]);
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /100% tests passed/);
  assert.equal(readFileSync(record.stderrPath, 'utf8'), '');
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'changed by command\n');
  assert.deepEqual(record.delta.paths, ['file.txt']);
  assert.equal(existsSync(join(project.store, 'runs', project.key, record.id, 'inflight.json')), false);
  assert.equal(readdirSync(join(project.store, 'runs', project.key, record.id)).some((name) => name.endsWith('.tmp')), false);
  assert.match(buildOperationHandoff(project, record), new RegExp(`RAW run:${record.id}`));
  assert.match(buildOperationHandoff(project, record), /MARKER NATIVE_TESTS=PASS count=3/);
  assert.deepEqual(await operationHistory(project), [{
    runId: record.id, type: 'repository-command', name: 'native-tests', query: null, scope: '.',
    command: 'node tools/run-native-tests.mjs', status: 'pass', durationMs: record.durationMs,
    provenance: record.provenance,
    startedAt: record.startedAt, evidence: 'CURRENT', reversible: true, result: '3/3 CTest',
  }]);
  const detail = await operationDetail(project, record.id);
  assert.equal(detail.runId, record.id);
  assert.deepEqual(detail.provenance, record.provenance);
  assert.deepEqual(detail.operation, record.operation);
  assert.equal(detail.evidence, 'CURRENT');
  assert.equal(detail.raw.stdout, record.stdoutPath);
  assert.match(detail.handoff, /OPERATION REPOSITORY-COMMAND/);
  assert.match(detail.handoff, /ORIGIN cli-argv/);
  assert.equal(runById(project, '../run.json'), null);

  assert.deepEqual(await undoPlan(project, record.id), {
    runId: record.id, operation: 'repository-command', state: 'SAFE', paths: ['file.txt'], fileCount: 1,
    reason: 'The recorded inverse patch applies cleanly to the current worktree.',
  });
  const undo = await undoOperation(project, record.id);
  assert.equal(undo.operation.type, 'undo');
  assert.equal(undo.operation.targetRunId, record.id);
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'initial\n');
  assert.equal((await undoPlan(project, undo.id)).state, 'SAFE');
  const redo = await undoOperation(project, undo.id);
  assert.equal(redo.operation.targetRunId, undo.id);
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'changed by command\n');
  writeFileSync(join(root, 'file.txt'), 'overlapping later edit\n');
  assert.equal((await undoPlan(project, record.id)).state, 'CONFLICT');
  await assert.rejects(() => undoOperation(project, record.id), /Undo is CONFLICT/);

  assert.equal((await operationHistory(project))[0].evidence, 'STALE');
  writeFileSync(join(root, 'file.txt'), 'initial\n');

  await assert.rejects(() => runRepositoryCommand(project, 'not-declared'), /Unknown repository command/);
  assert.equal(readProjectState(project).lastRunId, redo.id);
});

test('repository command cancellation preserves partial changes and reversible evidence', async () => {
  const root = fixture();
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'run-native-tests.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../partial.txt", import.meta.url), "partial\\n"); await new Promise((resolve) => setTimeout(resolve, 5000));\n');
  const identityPath = join(root, 'distribution', 'project.json');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  identity.commandHud = { commands: [{ name: 'native-tests', command: 'node tools/run-native-tests.mjs', argv: ['node', 'tools/run-native-tests.mjs'], owner: 'tools/run-native-tests.mjs', kind: 'test' }] };
  writeFileSync(identityPath, JSON.stringify(identity));
  execFileSync('git', ['add', 'tools/run-native-tests.mjs', 'distribution/project.json'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add cancellable fixture'], { cwd: root });
  const project = await resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'hud-cancel-state-')) } });
  const controller = new AbortController();
  let started = null;
  const pending = runRepositoryCommand(project, 'native-tests', {
    signal: controller.signal,
    onStart: (value) => { started = value; setTimeout(() => controller.abort(), 150); },
  });
  const record = await pending;
  assert.ok(started?.runId);
  assert.equal(record.id, started.runId);
  assert.equal(record.status, 'cancelled');
  assert.equal(record.operation.status, 'cancelled');
  assert.equal(existsSync(join(project.store, 'runs', project.key, record.id, 'inflight.json')), false);
  assert.deepEqual(record.delta.paths, ['partial.txt']);
  assert.equal(readFileSync(join(root, 'partial.txt'), 'utf8'), 'partial\n');
  assert.equal((await undoPlan(project, record.id)).state, 'SAFE');
  const undo = await undoOperation(project, record.id);
  assert.equal(undo.status, 'pass');
  assert.equal(existsSync(join(root, 'partial.txt')), false);
});

test('startup recovery records inactive in-flight evidence and preserves Undo', async () => {
  const project = await fixtureProject();
  const id = '20260824220000-dead';
  const directory = join(project.store, 'runs', project.key, id);
  mkdirSync(directory, { recursive: true });
  const before = await gitSnapshot(project.root);
  const currencyBefore = await repositoryCurrency(project.root);
  const treeBefore = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: project.root, encoding: 'utf8' }).trim();
  const stdoutPath = join(directory, 'stdout.log');
  const stderrPath = join(directory, 'stderr.log');
  writeFileSync(stdoutPath, 'STARTED\npartial output\n');
  writeFileSync(stderrPath, '');
  writeFileSync(join(project.root, 'interrupted.txt'), 'partial change\n');
  writeFileSync(join(directory, 'inflight.json'), JSON.stringify({
    schemaVersion: 1, id, project: project.identity.id, root: project.root,
    request: 'run repository command fixture', command: 'node fixture.mjs', argv: ['node', 'fixture.mjs'],
    objective: 'Run fixture', startedAt: '2026-08-24T22:00:00.000Z', pid: 2147483647,
    captureDelta: true, treeBefore, gitBefore: before, currencyBefore, stdoutPath, stderrPath,
    operationIdentity: { type: 'repository-command', name: 'fixture', displayCommand: 'node fixture.mjs' },
  }));

  assert.deepEqual(await recoverInterruptedRuns(project), { recovered: [id], detached: [], corrupt: [] });
  const record = runById(project, id);
  assert.equal(record.status, 'interrupted');
  assert.equal(record.exitCode, null);
  assert.equal(record.operation.status, 'interrupted');
  assert.deepEqual(record.provenance, { origin: 'legacy-unknown', finalizedBy: 'startup-recovery' });
  assert.deepEqual(record.operation.provenance, record.provenance);
  assert.deepEqual(record.delta.paths, ['interrupted.txt']);
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /partial output/);
  assert.equal(existsSync(join(directory, 'inflight.json')), false);
  assert.equal((await undoPlan(project, id)).state, 'SAFE');
  await undoOperation(project, id);
  assert.equal(existsSync(join(project.root, 'interrupted.txt')), false);
  assert.deepEqual(await recoverInterruptedRuns(project), { recovered: [], detached: [], corrupt: [] });

  const liveId = '20260824220100-beef';
  const liveDirectory = join(project.store, 'runs', project.key, liveId);
  const liveStartedAt = new Date().toISOString();
  mkdirSync(liveDirectory, { recursive: true });
  const liveStdout = join(liveDirectory, 'stdout.log');
  const liveStderr = join(liveDirectory, 'stderr.log');
  writeFileSync(liveStdout, 'still running\n');
  writeFileSync(liveStderr, '');
  writeFileSync(join(liveDirectory, 'inflight.json'), JSON.stringify({
    schemaVersion: 1, id: liveId, project: project.identity.id, root: project.root, pid: process.pid,
    command: 'node still-running.mjs', argv: ['node', 'still-running.mjs'], startedAt: liveStartedAt,
    captureDelta: true, treeBefore, gitBefore: before, currencyBefore,
    stdoutPath: liveStdout, stderrPath: liveStderr,
  }));
  assert.deepEqual(await recoverInterruptedRuns(project), {
    recovered: [], detached: [{ runId: liveId, pid: process.pid, command: 'node still-running.mjs', startedAt: liveStartedAt }], corrupt: [],
  });
  rmSync(liveDirectory, { recursive: true, force: true });

  const corruptId = '20260824220200-baad';
  const corruptDirectory = join(project.store, 'runs', project.key, corruptId);
  mkdirSync(corruptDirectory, { recursive: true });
  writeFileSync(join(corruptDirectory, 'inflight.json'), '{"truncated":');
  const corruption = await recoverInterruptedRuns(project);
  assert.deepEqual(corruption.recovered, []);
  assert.deepEqual(corruption.detached, []);
  assert.equal(corruption.corrupt.length, 1);
  assert.equal(corruption.corrupt[0].runId, corruptId);
  assert.match(corruption.corrupt[0].reason, /valid JSON object evidence/);
  assert.equal(readFileSync(join(corruptDirectory, 'inflight.json'), 'utf8'), '{"truncated":');
  rmSync(corruptDirectory, { recursive: true, force: true });
});

test('reducers retain concise evidence and cause classification', () => {
  const pass = reduceOutput('npm test', '100% tests passed, 0 tests failed out of 9', '', 0);
  assert.deepEqual(pass.summary, ['9/9 CTest']);
  const compactPass = reduceOutput('npm test', '100% tests passed out of 9\nMULTIPLAYER_PROTOCOL_OK', '', 0);
  assert.deepEqual(compactPass.summary, ['9/9 CTest']);
  const modernNodePass = reduceOutput('cmd.exe /d /s /c "npm.cmd run hud:test"', 'ℹ tests 28\nℹ pass 28\nℹ fail 0', '', 0);
  assert.deepEqual(modernNodePass.summary, ['28/28 node tests']);
  const fail = reduceOutput('npm test', '', 'Error: assertion failed', 1);
  assert.equal(fail.classification, 'test');
});


test('reducers do not infer verification from arbitrary printed source text', () => {
  const printedSource = [
    '100% tests passed, 0 tests failed out of 9',
    'found 0 vulnerabilities',
    'ASSET_MIRRORS=PASS count=7',
    'SMOKE_TEST_OK',
    'MULTIPLAYER_PROTOCOL_OK',
  ].join('\n');
  const value = reduceOutput('pwsh.exe -NoProfile -EncodedCommand abc', printedSource, '', 0);
  assert.deepEqual(value.summary, []);
});

test('PowerShell unknown command is blocked but missing filesystem path is not', async () => {
  const project = await fixtureProject();

  const blocked = await runCommand(
    project,
    [process.execPath, '-e', `console.error("x: The term 'x' is not recognized as a name of a cmdlet, function, script file, or executable program."); process.exit(1)`],
    { stream: false },
  );
  assert.equal(blocked.status, 'blocked');

  const ordinaryFailure = await runCommand(
    project,
    [process.execPath, '-e', `console.error("Get-Item: Cannot find path 'C:\\missing' because it does not exist."); process.exit(1)`],
    { stream: false },
  );
  assert.equal(ordinaryFailure.status, 'fail');
});

test('PowerShell CLIXML errors become ordinary readable text', () => {
  const xml = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">_x001B_[31;1mGet-Item: _x001B_[31;1mCannot find path &apos;C:\\missing&apos; because it does not exist._x001B_[0m_x000D__x000A_</S></Objs>';
  const value = reduceOutput('pwsh.exe', '', xml, 1);
  assert.equal(value.cause, "Get-Item: Cannot find path 'C:\\missing' because it does not exist.");
  assert.doesNotMatch(value.tail.join('\n'), /<Objs|_x001B_|xmlns=/);
});

test('terminal presentation strips ANSI, shortens repo roots, and removes PowerShell boilerplate', () => {
  const value = reduceOutput(
    'pwsh.exe',
    '\x1b[31;1mFAIL\x1b[0m C:\\repo\\file.cpp\n',
    [
      'Thing failed',
      'At line:1 char:12',
      '+ bad command',
      '+ ~~~~~~~~~~~',
      '    + CategoryInfo          : NotSpecified: (...)',
      '    + FullyQualifiedErrorId : NativeCommandError',
    ].join('\n'),
    1,
    { root: 'C:\\repo' },
  );

  assert.equal(value.cause, 'Thing failed');
  assert.match(value.tail.join('\n'), /FAIL \.\\file\.cpp/);
  assert.match(value.tail.join('\n'), /At line:1 char:12/);
  assert.doesNotMatch(value.tail.join('\n'), /CategoryInfo|FullyQualifiedErrorId|\x1b/);
});

test('reducers accept evidence from matching authoritative commands', () => {
  assert.deepEqual(
    reduceOutput('ctest --output-on-failure', '100% tests passed, 0 tests failed out of 9', '', 0).summary,
    ['9/9 CTest'],
  );
  assert.deepEqual(reduceOutput('python tools/verify_asset_mirrors.py', 'ASSET_MIRRORS=PASS count=7', '', 0, {
    successMarkers: [{ contains: 'ASSET_MIRRORS=PASS', summary: 'asset mirrors' }],
  }).summary, ['asset mirrors']);
});

test('run records preserve human request separately from transport', async () => {
  const project = await fixtureProject();
  const record = await runCommand(
    project,
    [process.execPath, '-e', 'console.log("transport ok")'],
    { request: 'show simple result', stream: false },
  );
  assert.equal(record.request, 'show simple result');
  assert.match(record.command, /node|process/i);
  assert.equal(record.packet.OBJECTIVE, 'show simple result');
});

test('verified project execution persists immutable evidence and packet', async () => {
  const project = await fixtureProject();
  const record = await runCommand(project, [process.execPath, '-e', 'console.log("SMOKE_TEST_OK")'], { objective: 'prove success', stream: false });
  assert.equal(record.status, 'pass');
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /SMOKE_TEST_OK/);
  assert.match(formatPacket(record.packet), /STATUS=PASS/);
  assert.ok(readFileSync(record.stdoutPath.replace(/stdout\.log$/, 'run.json'), 'utf8').includes(record.id));
});

test('failed commands remain failed while preserving raw stderr', async () => {
  const project = await fixtureProject();
  const record = await runCommand(project, [process.execPath, '-e', 'console.error("Error: expected failure"); process.exit(7)'], { stream: false });
  assert.equal(record.status, 'fail');
  assert.equal(record.exitCode, 7);
  assert.match(readFileSync(record.stderrPath, 'utf8'), /expected failure/);
});

test('any Git repository is verified while non-repositories are rejected', async () => {
  const root = fixture();
  writeFileSync(join(root, 'file.txt'), 'dirty\n');
  assert.equal((await gitSnapshot(root)).dirty, true);
  const generic = mkdtempSync(join(tmpdir(), 'hud-generic-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: generic });
  const project = await resolveProject({ cwd: generic, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } });
  assert.match(project.identity.id, /^local\/hud-generic-/);
  assert.equal(project.identity.source, 'git-root');
  const outside = mkdtempSync(join(tmpdir(), 'hud-outside-'));
  await assert.rejects(resolveProject({ cwd: outside, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } }), /No Git repository/);
});

test('explicit project identity overrides remote-derived identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-identity-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/inferred.git'], { cwd: root });
  writeFileSync(join(root, 'commandhud.project.json'), JSON.stringify({ id: 'owner/declared', name: 'Declared project' }));
  const project = await resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'hud-identity-state-')) } });
  assert.equal(project.identity.id, 'owner/declared');
  assert.equal(project.identity.name, 'Declared project');
  assert.equal(project.identity.source, 'commandhud.project.json');
});

test('update comparison uses canonical manifest commit and platform artifact', async () => {
  const project = await fixtureProject();
  const root = project.root;
  const head = (await gitSnapshot(root)).head;
  const response = { ok: true, json: async () => ({ commit: head, artifacts: { 'windows-x64': { sha256: 'abc' } } }) };
  const update = await fetchUpdate(project, async () => response);
  assert.equal(update.status, 'current');

  writeFileSync(join(root, 'file.txt'), 'new local commit\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'local ahead'], { cwd: root });
  const ahead = await fetchUpdate(project, async () => response);
  assert.equal(ahead.status, 'local_ahead');
});

test('presentation exposes semantic result without transport noise', async () => {
  const project = await fixtureProject();

  const pass = await runCommand(
    project,
    [process.execPath, '-e', 'console.log("VISIBLE_RESULT")'],
    { request: 'simple human request', stream: false },
  );

  assert.equal(pass.presentation.status, 'pass');
  assert.equal(pass.presentation.request, 'simple human request');
  assert.equal(pass.presentation.headline, 'VISIBLE_RESULT');
  assert.doesNotMatch(pass.presentation.request, /EncodedCommand|node\.exe/i);

  const fail = await runCommand(
    project,
    [process.execPath, '-e', 'console.error("Error: compact failure"); process.exit(3)'],
    { request: 'failing human request', stream: false },
  );

  assert.equal(fail.presentation.status, 'fail');
  assert.equal(fail.presentation.request, 'failing human request');
  assert.equal(fail.presentation.headline, 'Error: compact failure');
  assert.equal(fail.presentation.exitCode, 3);
});

test('workflow view is derived from immutable run records', async () => {
  const project = await fixtureProject();

  await runCommand(
    project,
    [process.execPath, '-e', 'console.log("inspect ok")'],
    {
      request: 'inspect',
      workflow: { id: 'wf-1', name: 'verify current change', stage: 'inspect', index: 1, count: 3 },
      stream: false,
    },
  );

  await runCommand(
    project,
    [process.execPath, '-e', 'console.error("AssertionError: stage failed"); process.exit(1)'],
    {
      request: 'test',
      workflow: { id: 'wf-1', name: 'verify current change', stage: 'test', index: 2, count: 3 },
      stream: false,
    },
  );

  const value = workflowView(project, 'wf-1');
  assert.equal(value.name, 'verify current change');
  assert.equal(value.stageCount, 3);
  assert.equal(value.currentStage, 2);
  assert.equal(value.status, 'fail');
  assert.deepEqual(value.stages.map((stage) => stage.stage), ['inspect', 'test']);
  assert.match(value.stages[1].headline, /AssertionError/);
});

test('workflow view resolves retries from latest immutable stage attempts', async () => {
  const project = await fixtureProject();

  await runCommand(
    project,
    [process.execPath, '-e', 'console.log("inspect ok")'],
    {
      request: 'inspect',
      workflow: { id: 'wf-retry', name: 'retry workflow', stage: 'inspect', index: 1, count: 3 },
      stream: false,
    },
  );

  await runCommand(
    project,
    [process.execPath, '-e', 'console.error("AssertionError: first attempt failed"); process.exit(1)'],
    {
      request: 'test',
      workflow: { id: 'wf-retry', name: 'retry workflow', stage: 'test', index: 2, count: 3 },
      stream: false,
    },
  );

  let value = workflowView(project, 'wf-retry');
  assert.equal(value.status, 'fail');
  assert.equal(value.nextStage, 2);
  assert.deepEqual(value.pendingStages, [3]);

  await runCommand(
    project,
    [process.execPath, '-e', 'console.log("test repaired")'],
    {
      request: 'retry test',
      workflow: { id: 'wf-retry', name: 'retry workflow', stage: 'test', index: 2, count: 3 },
      stream: false,
    },
  );

  value = workflowView(project, 'wf-retry');

  assert.equal(value.status, 'in_progress');
  assert.equal(value.currentStage, 2);
  assert.equal(value.nextStage, 3);
  assert.deepEqual(value.pendingStages, [3]);
  assert.equal(value.completedStages, 2);
  assert.deepEqual(value.stages.map((stage) => stage.status), ['pass', 'pass']);
  assert.equal(value.stages[1].attempts, 2);
});

test('workflow packet is compact and represents pending and retried stages', () => {
  const packet = buildWorkflowPacket({
    name: 'verify current change',
    status: 'in_progress',
    stageCount: 3,
    currentStage: 2,
    nextStage: 3,
    stages: [
      {
        index: 1,
        stage: 'inspect',
        status: 'pass',
        attempts: 1,
        startedAt: '2026-01-01T00:00:00Z',
      },
      {
        index: 2,
        stage: 'test',
        status: 'pass',
        attempts: 2,
        startedAt: '2026-01-01T00:01:00Z',
      },
    ],
  });

  assert.equal(packet, [
    'WORKFLOW=verify current change',
    'STATUS=IN_PROGRESS',
    'STAGE_1=inspect PASS',
    'STAGE_2=test PASS attempts=2',
    'STAGE_3=PENDING',
    'CURRENT=2/3',
    'NEXT=3',
  ].join('\n'));
});

test('current semantic state derives renderer-neutral project, cwd, git, workflow, and last-run facts', async () => {
  const project = await fixtureProject();
  await runCommand(project, [process.execPath, '-e', 'console.log("STATE_OK")'], {
    stream: false,
    request: 'inspect semantic state',
    workflow: { id: 'state-wf', name: 'state contract', stage: 'inspect', index: 1, count: 2 },
  });

  const value = await currentState(project, { cwd: join(project.root, 'tools', 'hud') });
  assert.equal(value.project.id, 'indrolend/data');
  assert.equal(value.cwd.display.replaceAll('\\', '/'), 'tools/hud');
  assert.equal(value.git.dirty, false);
  assert.ok(value.repository.root.files.some((file) => file.path === 'file.txt'));
  assert.deepEqual(value.commands, []);
  assert.equal(value.workflow.name, 'state contract');
  assert.equal(value.workflow.status, 'in_progress');
  assert.equal(value.last.stage, 'inspect');
  assert.equal(value.last.status, 'pass');
  assert.equal(value.next, 2);
  assert.equal(value.status, 'in_progress');
});

test('current semantic state never presents a cwd outside the selected repository', async () => {
  const project = await fixtureProject();
  const outside = mkdtempSync(join(tmpdir(), 'hud-state-outside-'));
  const value = await currentState(project, { cwd: outside });
  assert.equal(value.cwd.absolute, project.root);
  assert.equal(value.cwd.display, '.');
});

test('packet schema contains only deterministic continuation fields', () => {
  const packet = buildPacket({
    status: 'pass', objective: 'test', command: 'npm test', exitCode: 0,
    gitAfter: { head: 'a'.repeat(40), branch: 'main', dirty: false, changedFiles: [] },
    reduction: { summary: ['9/9 CTest'], cause: null }, stdoutPath: 'out', stderrPath: 'err',
  });
  assert.deepEqual(Object.keys(packet), ['STATUS', 'OBJECTIVE', 'AUTHORITY', 'CHANGE', 'VERIFY', 'RESULT', 'FRONTIER']);
});

test('repository currency is content-stable and ignores ignored output', async () => {
  const project = await fixtureProject();
  const first = await repositoryCurrency(project.root);
  assert.deepEqual(await repositoryCurrency(project.root), first);
  writeFileSync(join(project.root, 'file.txt'), 'changed with same dirty filename\n');
  const dirty = await repositoryCurrency(project.root);
  assert.notEqual(dirty.worktreeFingerprint, first.worktreeFingerprint);
  writeFileSync(join(project.root, 'file.txt'), 'initial\n');
  assert.equal((await repositoryCurrency(project.root)).worktreeFingerprint, first.worktreeFingerprint);
  writeFileSync(join(project.root, 'new.txt'), 'untracked\n');
  assert.notEqual((await repositoryCurrency(project.root)).worktreeFingerprint, first.worktreeFingerprint);
  writeFileSync(join(project.root, '.gitignore'), 'build/\nnew.txt\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: project.root });
  execFileSync('git', ['commit', '-m', 'ignore output'], { cwd: project.root });
  const ignoredBase = await repositoryCurrency(project.root);
  mkdirSync(join(project.root, 'build'));
  writeFileSync(join(project.root, 'build', 'artifact.bin'), 'one');
  assert.deepEqual(await repositoryCurrency(project.root), ignoredBase);
});

test('repository tree projects real hierarchy, changes, and ignored-file boundaries deterministically', async () => {
  const root = fixture();
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  writeFileSync(join(root, 'src', 'zeta.js'), 'export default 1;\n');
  writeFileSync(join(root, 'src', 'alpha.js'), 'export default 2;\n');
  writeFileSync(join(root, 'src', 'nested', 'value.txt'), 'value\n');
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  mkdirSync(join(root, 'ignored'));
  writeFileSync(join(root, 'ignored', 'artifact.bin'), 'ignored');
  execFileSync('git', ['add', '.gitignore', 'src'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'tree fixture'], { cwd: root });
  writeFileSync(join(root, 'src', 'alpha.js'), 'changed\n');
  writeFileSync(join(root, 'src', 'untracked.js'), 'untracked\n');

  const first = await repositoryTree(root);
  const second = await repositoryTree(root);
  assert.deepEqual(second, first);
  const src = first.root.directories.find((directory) => directory.path === 'src');
  assert.ok(src);
  assert.deepEqual(src.files.map((file) => file.name), ['alpha.js', 'untracked.js', 'zeta.js']);
  assert.equal(src.directories[0].path, 'src/nested');
  assert.equal(src.files.find((file) => file.name === 'alpha.js').gitStatus, ' M');
  assert.equal(src.files.find((file) => file.name === 'untracked.js').gitStatus, '??');
  assert.equal(first.root.directories.some((directory) => directory.name === 'ignored'), false);
});

test('search records real scoped matches, truthful zero results, raw evidence, and one compact handoff model', async () => {
  const project = await fixtureProject();
  mkdirSync(join(project.root, 'src'));
  writeFileSync(join(project.root, 'src', 'alpha.txt'), 'needle first\nplain\nneedle third\n');
  writeFileSync(join(project.root, 'src', 'beta.txt'), 'needle only\n');
  writeFileSync(join(project.root, 'outside.txt'), 'needle outside scope\n');

  const record = await searchRepository(project, 'needle', 'src');
  assert.equal(record.status, 'pass');
  assert.equal(record.operation.matchCount, 3);
  assert.equal(record.operation.fileCount, 2);
  assert.deepEqual(record.operation.files, [
    { path: 'src/alpha.txt', count: 2, lines: [1, 3] },
    { path: 'src/beta.txt', count: 1, lines: [1] },
  ]);
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /src[\\/]alpha\.txt:1:needle first/);
  assert.equal(readFileSync(record.stderrPath, 'utf8'), '');
  assert.deepEqual(parseSearchOutput(readFileSync(record.stdoutPath, 'utf8')), {
    matches: record.operation.matchCount,
    files: record.operation.files,
  });
  const state = await currentState(project);
  assert.deepEqual(state.lastOperation, record.operation);
  const handoff = buildOperationHandoff(project, record);
  assert.match(handoff, new RegExp(`RAW run:${record.id}`));
  assert.match(handoff, /src\/alpha\.txt 2 lines=1,3/);
  assert.ok(handoff.length < readFileSync(record.stdoutPath, 'utf8').length + 600);

  const zero = await searchRepository(project, 'definitely-not-present', 'src');
  assert.equal(zero.status, 'pass');
  assert.equal(zero.exitCode, 1);
  assert.deepEqual(zero.operation.files, []);
  assert.equal(zero.operation.matchCount, 0);

  const failed = await searchRepository(project, 'needle', 'src', { tool: process.execPath });
  assert.equal(failed.status, 'fail');
  assert.equal(failed.operation.matchCount, 0);
  assert.notEqual(failed.exitCode, 0);
  assert.notEqual(readFileSync(failed.stderrPath, 'utf8'), '');

  const unavailable = await searchRepository(project, 'needle', 'src', { tool: 'commandhud-missing-search-tool' });
  assert.equal(unavailable.status, 'blocked');
  assert.equal(unavailable.operation.toolAvailable, false);
  assert.match(readFileSync(unavailable.stderrPath, 'utf8'), /ENOENT|not found/i);
});

test('search result paths share repository projection identity at root scope', () => {
  assert.deepEqual(parseSearchOutput('./src/alpha.txt:4:needle\r\n.\\src\\beta.txt:7:needle\r\n'), {
    matches: 2,
    files: [
      { path: 'src/alpha.txt', count: 1, lines: [4] },
      { path: 'src/beta.txt', count: 1, lines: [7] },
    ],
  });
});

test('terminal commands preserve exact intent and working directory across available major shells', async () => {
  const project = await fixtureProject();
  mkdirSync(join(project.root, 'sub'));
  const shells = await discoverShells(project.root);
  assert.ok(shells.some((shell) => shell.available));
  const cases = {
    powershell: { command: "Set-Location sub; Write-Output 'PS_OK'", output: /PS_OK/ },
    bash: { command: 'cd sub', output: /^$/ },
    cmd: { command: 'cd sub && echo CMD_OK', output: /CMD_OK/ },
  };
  for (const shell of shells.filter((entry) => entry.available)) {
    const example = cases[shell.id];
    const record = await runTerminalCommand(project, example.command, { shell: shell.id });
    assert.equal(record.status, 'pass', `${shell.id}: ${readFileSync(record.stderrPath, 'utf8')}`);
    assert.equal(record.command, example.command);
    assert.notEqual(record.transportCommand, record.command);
    assert.equal(record.operation.shell, shell.id);
    assert.equal(record.operation.cwdAfter, join(project.root, 'sub'), JSON.stringify(record.operation));
    assert.equal(record.operation.cwdPersistence, 'updated');
    assert.match(readFileSync(record.stdoutPath, 'utf8'), example.output);
  }
});

test('terminal working directory cannot persist outside the verified repository', async () => {
  const project = await fixtureProject();
  const shell = (await discoverShells(project.root)).find((entry) => entry.available && entry.id === (process.platform === 'win32' ? 'powershell' : 'bash'));
  const command = shell.id === 'powershell' ? 'Set-Location ..' : 'cd ..';
  const record = await runTerminalCommand(project, command, { shell: shell.id });
  assert.equal(record.operation.cwdPersistence, 'outside-repository');
  assert.equal(record.operation.cwdAfter, project.root);
});

test('terminal context export is truthful, bounded, and benchmarked against raw evidence', async () => {
  const project = await fixtureProject();
  const shells = await discoverShells(project.root);
  const shell = shells.find((entry) => entry.available && entry.id === (process.platform === 'win32' ? 'powershell' : 'bash'));
  const command = shell.id === 'powershell'
    ? "1..120 | ForEach-Object { Write-Output (('line {0} ' -f $_) + ('x' * 100)) }; [Console]::Error.WriteLine('TERMINAL_ERROR_EVIDENCE')"
    : "for i in $(seq 1 120); do printf 'line %s %100s\\n' \"$i\" x; done; printf 'TERMINAL_ERROR_EVIDENCE\\n' >&2";
  const record = await runTerminalCommand(project, command, { shell: shell.id });
  const context = await buildCurrentOperationContext(project, record);
  assert.match(context.handoff, /EVIDENCE CURRENT/);
  assert.match(context.handoff, /OPERATION TERMINAL-COMMAND/);
  assert.match(context.handoff, new RegExp(`COMMAND ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(context.handoff, /STDOUT_EXCERPT \(tail, bounded\)/);
  assert.match(context.handoff, /line 120/);
  assert.doesNotMatch(context.handoff, /line 1 x/);
  assert.match(context.handoff, /STDERR_EXCERPT\nTERMINAL_ERROR_EVIDENCE/);
  assert.match(context.handoff, new RegExp(`RAW run:${record.id}`));
  assert.ok(context.metrics.rawBytes > context.metrics.contextBytes);
  assert.ok(context.metrics.reductionPercent > 0);
  assert.equal(context.metrics.savedBytes, context.metrics.rawBytes - context.metrics.contextBytes);
  const detail = await operationDetail(project, record.id);
  assert.deepEqual(detail.contextMetrics, context.metrics);
  assert.equal(detail.handoff, context.handoff);
});

test('evidence currency is current, stale, or unknown', () => {
  const current = { head: 'a', worktreeFingerprint: 'sha256:one' };
  assert.equal(classifyEvidence(current, current), 'CURRENT');
  assert.equal(classifyEvidence({ ...current, worktreeFingerprint: 'sha256:two' }, current), 'STALE');
  assert.equal(classifyEvidence({ ...current, head: 'b' }, current), 'STALE');
  assert.equal(classifyEvidence(null, current), 'UNKNOWN');
});

test('current handoff context exposes currency without changing historical evidence', async () => {
  const project = await fixtureProject();
  const shell = (await discoverShells(project.root)).find((entry) => entry.available && entry.id === (process.platform === 'win32' ? 'powershell' : 'bash'));
  const record = await runTerminalCommand(project, 'echo evidence', { shell: shell.id, stream: false });
  const current = await buildCurrentOperationContext(project, record);
  assert.match(current.handoff, /EVIDENCE CURRENT/);

  writeFileSync(join(project.root, 'later.txt'), 'changed after the run');
  const stale = await buildCurrentOperationContext(project, record);
  assert.match(stale.handoff, /EVIDENCE STALE/);
  assert.match(stale.handoff, new RegExp(`RUN_HEAD ${record.currencyAfter.head}`));
  assert.match(stale.handoff, /CURRENT_HEAD [0-9a-f]{40}/);
  assert.match(stale.handoff, new RegExp(`RAW run:${record.id}`));
});

test('runs store before/after currency and legacy records remain unknown', async () => {
  const project = await fixtureProject();
  const record = await runCommand(project, [process.execPath, '-e', 'process.exit(0)'], { stream: false });
  assert.ok(record.currencyBefore.worktreeFingerprint);
  assert.deepEqual(record.currencyBefore, record.currencyAfter);
  const legacy = { id: 'legacy' };
  assert.equal(classifyEvidence(legacy.currencyAfter, await repositoryCurrency(project.root)), 'UNKNOWN');
});

test('objective and frontier persist, clear, and retain establishment currency', async () => {
  const project = await fixtureProject();
  const currency = await repositoryCurrency(project.root);
  setWorkingValue(project, 'objective', 'Continuation fixture', currency);
  setWorkingValue(project, 'frontier', 'Run synthetic verification', currency);
  assert.equal(workingValue(project, 'objective').value, 'Continuation fixture');
  assert.equal(readProjectState(project).frontier.value, 'Run synthetic verification');
  setWorkingValue(project, 'objective', null, currency);
  setWorkingValue(project, 'frontier', null, currency);
  assert.equal(workingValue(project, 'objective'), null);
  assert.equal(workingValue(project, 'frontier'), null);
});

test('continuation reports current success, current failure, and stale evidence without inventing state', async () => {
  const project = await fixtureProject();
  let value = await continuation(project);
  assert.equal(value.workingState.objective, null);
  assert.equal(value.workingState.frontier, null);
  const pass = await runCommand(project, [process.execPath, '-e', 'console.log("ok")'], { stream: false });
  value = await continuation(project);
  assert.equal(value.lastMeaningfulRun.runId, pass.id);
  assert.equal(value.lastMeaningfulRun.evidence, 'CURRENT');
  const fail = await runCommand(project, [process.execPath, '-e', 'console.error("Error: fixture"); process.exit(4)'], { stream: false });
  value = await continuation(project);
  assert.equal(value.lastFailure.runId, fail.id);
  assert.equal(value.lastFailure.evidence, 'CURRENT');
  writeFileSync(join(project.root, 'file.txt'), 'changed\n');
  value = await continuation(project);
  assert.equal(value.recentEvidence[0].evidence, 'STALE');
  assert.equal(value.counts.stale, 2);
});
