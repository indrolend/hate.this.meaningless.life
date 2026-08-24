import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildOperationHandoff, buildPacket, buildWorkflowPacket, classifyEvidence, continuation, currentState, discoverCommands, fetchUpdate, formatPacket, gitSnapshot, operationDetail, operationHistory, parseSearchOutput, readProjectState, reduceOutput, repositoryCurrency, repositoryTree, resolveProject, runById, runCommand, runRepositoryCommand, searchRepository, setWorkingValue, undoOperation, undoPlan, workingValue, workflowView } from './core.mjs';

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

test('repository command discovery derives a deterministic inspectable library', () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-commands-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs', build: 'node build.mjs' } }));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'run-native-tests.mjs'), '');
  assert.deepEqual(discoverCommands(root), [
    { name: 'npm:build', command: 'npm run build' },
    { name: 'npm:test', command: 'npm run test' },
    { name: 'native-tests', command: 'node tools/run-native-tests.mjs' },
  ]);
});

test('repository command execution resolves a current discovered identity and records evidence', async () => {
  const root = fixture();
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'run-native-tests.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../file.txt", import.meta.url), "changed by command\\n"); console.log("100% tests passed, 0 tests failed out of 3")\n');
  execFileSync('git', ['add', 'tools/run-native-tests.mjs'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add command fixture'], { cwd: root });
  const project = await resolveProject({ cwd: root, env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'hud-command-state-')) } });

  const record = await runRepositoryCommand(project, 'native-tests');
  assert.equal(record.status, 'pass');
  assert.equal(record.operation.type, 'repository-command');
  assert.equal(record.operation.name, 'native-tests');
  assert.equal(record.operation.displayCommand, 'node tools/run-native-tests.mjs');
  assert.equal(record.operation.command, 'node tools/run-native-tests.mjs');
  assert.deepEqual(record.operation.summary, ['3/3 CTest']);
  assert.match(readFileSync(record.stdoutPath, 'utf8'), /100% tests passed/);
  assert.equal(readFileSync(record.stderrPath, 'utf8'), '');
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'changed by command\n');
  assert.deepEqual(record.delta.paths, ['file.txt']);
  assert.match(buildOperationHandoff(project, record), new RegExp(`RAW run:${record.id}`));
  assert.deepEqual(await operationHistory(project), [{
    runId: record.id, type: 'repository-command', name: 'native-tests', query: null, scope: '.',
    command: 'node tools/run-native-tests.mjs', status: 'pass', durationMs: record.durationMs,
    startedAt: record.startedAt, evidence: 'CURRENT', reversible: true, result: '3/3 CTest',
  }]);
  const detail = await operationDetail(project, record.id);
  assert.equal(detail.runId, record.id);
  assert.deepEqual(detail.operation, record.operation);
  assert.equal(detail.evidence, 'CURRENT');
  assert.equal(detail.raw.stdout, record.stdoutPath);
  assert.match(detail.handoff, /OPERATION REPOSITORY-COMMAND/);
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
  assert.deepEqual(
    reduceOutput('python tools/verify_asset_mirrors.py', 'ASSET_MIRRORS=PASS count=7', '', 0).summary,
    ['asset mirrors'],
  );
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

test('wrong repositories are rejected and dirty state is captured', async () => {
  const root = fixture();
  writeFileSync(join(root, 'file.txt'), 'dirty\n');
  assert.equal((await gitSnapshot(root)).dirty, true);
  const wrong = mkdtempSync(join(tmpdir(), 'hud-wrong-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: wrong });
  await assert.rejects(resolveProject({ cwd: wrong, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } }), /not the verified/);
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

test('evidence currency is current, stale, or unknown', () => {
  const current = { head: 'a', worktreeFingerprint: 'sha256:one' };
  assert.equal(classifyEvidence(current, current), 'CURRENT');
  assert.equal(classifyEvidence({ ...current, worktreeFingerprint: 'sha256:two' }, current), 'STALE');
  assert.equal(classifyEvidence({ ...current, head: 'b' }, current), 'STALE');
  assert.equal(classifyEvidence(null, current), 'UNKNOWN');
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
