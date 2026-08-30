import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createTuiInputRouter, deliverShellProjection, deliverShellResult, encodeClipboardInput, parseShellEvidenceCommand, renderShellEvidenceProjection, renderShellResult, routeTuiInput, shellInputIncomplete, startHudShell } from './shell.mjs';
import { listRuns, resolveProject, runRepositoryCommand } from './core.mjs';

async function shellProject() {
  const root = mkdtempSync(join(tmpdir(), 'commandhud-shell-project-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root });
  return resolveProject({ root, env: { ...process.env, HUD_STATE_ROOT: join(root, '.state') } });
}

test('TUI input routes mouse and keyboard controls semantically without typing slash commands', () => {
  const dispatched = [];
  const typed = [];
  let restored = 0;
  const state = { focus: null, hover: null };
  const actions = ['copy', 'raw', 'undo', 'help', 'exit'];
  const layout = {
    actionAt(column, row) { return row === 24 && column >= 19 && column <= 32 ? 'copy' : null; },
    setHover(action) { state.hover = action; },
    setFocus(action) { state.focus = action; },
    moveFocus(direction) {
      const current = actions.indexOf(state.focus);
      state.focus = actions[(current < 0 ? (direction < 0 ? actions.length - 1 : 0) : current + direction + actions.length) % actions.length];
    },
    get focusedAction() { return state.focus; },
  };
  const route = (value) => routeTuiInput(value, {
    layout, dispatch: (action) => dispatched.push(action), writeText: (text) => typed.push(text), restoreEditor: () => { restored++; },
  });
  route('git status');
  route('\x1b[<35;19;24M');
  route('\x1b[<0;19;24M');
  route('\x1b[<0;19;24m');
  assert.equal(typed.join(''), 'git status');
  assert.deepEqual(dispatched, ['copy']);
  assert.equal(state.focus, 'copy');
  assert.doesNotMatch(typed.join(''), /\/copy|0/);
  route('\t');
  assert.equal(state.focus, 'raw');
  route('\r');
  assert.deepEqual(dispatched, ['copy', 'raw']);
  route('\x1b');
  assert.equal(state.focus, null);
  assert.equal(restored, 1);
  route('x');
  assert.equal(typed.join(''), 'git statusx');
});

test('TUI input buffers fragmented SGR mouse packets instead of leaking partial digits', () => {
  const typed = [];
  const dispatched = [];
  const layout = {
    actionAt(column, row) { return column === 19 && row === 24 ? 'copy' : null; },
    setHover() {}, setFocus() {}, moveFocus() {}, get focusedAction() { return null; },
  };
  const route = createTuiInputRouter({
    layout, dispatch: (action) => dispatched.push(action), writeText: (text) => typed.push(text),
  });
  route('echo ok\x1b[<0;1');
  route('9;24M\x1b[<0;19;');
  route('24m');
  assert.equal(typed.join(''), 'echo ok');
  assert.deepEqual(dispatched, ['copy']);
});

test('terminal evidence commands target the latest or an explicit immutable run', () => {
  const runId = '20260826010101-abcd';
  const older = '20260825020202-1234';
  assert.deepEqual(parseShellEvidenceCommand('/head 12', runId), { runId, mode: 'head', count: '12' });
  assert.deepEqual(parseShellEvidenceCommand(`/head ${older} 5`, runId), { runId: older, mode: 'head', count: '5' });
  assert.deepEqual(parseShellEvidenceCommand(`/head 5 ${older}`, runId), { runId: older, mode: 'head', count: '5' });
  assert.deepEqual(parseShellEvidenceCommand(`/tail ${older} 5`, runId), { runId: older, mode: 'tail', count: '5' });
  assert.deepEqual(parseShellEvidenceCommand(`/find ${older} exact useful text`, runId), { runId: older, mode: 'find', pattern: 'exact useful text' });
  assert.deepEqual(parseShellEvidenceCommand('/find exact useful text', runId), { runId, mode: 'find', pattern: 'exact useful text' });
  assert.deepEqual(parseShellEvidenceCommand(`/around ${older} failure 3`, runId), { runId: older, mode: 'around', pattern: 'failure', context: '3' });
  assert.deepEqual(parseShellEvidenceCommand(`/raw ${older}`, runId), { runId: older, mode: 'raw' });
  assert.throws(() => parseShellEvidenceCommand(`/head ${older} 5 extra`, runId), /Syntax/);
  assert.throws(() => parseShellEvidenceCommand('/find', runId), /Syntax/);
  assert.throws(() => parseShellEvidenceCommand('/raw', null), /No command has been recorded/);
});

test('terminal proof reuses and copies retained evidence without creating an outer run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commandhud-shell-proof-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  const distribution = join(root, 'distribution');
  mkdirSync(distribution);
  writeFileSync(join(distribution, 'project.json'), JSON.stringify({
    id: 'fixture/shell-proof', commandHud: { commands: [{
      name: 'verify', command: 'node -e pass', argv: [process.execPath, '-e', "console.log('PASS')"],
    }] },
  }));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
  const project = await resolveProject({ root, env: { ...process.env, HUD_STATE_ROOT: mkdtempSync(join(tmpdir(), 'commandhud-shell-proof-state-')) } });
  const record = await runRepositoryCommand(project, 'verify');
  const before = listRuns(project, Number.MAX_SAFE_INTEGER).length;
  const input = new PassThrough();
  input.end('/proof verify\n/exit\n');
  let output = '';
  const copies = [];
  await startHudShell(project, { input, output: { write(value) { output += value; } }, clipboardWriter(value) { copies.push(value); }, visual: false });
  assert.equal(listRuns(project, Number.MAX_SAFE_INTEGER).length, before);
  assert.match(output, new RegExp(`PROOF CURRENT[\\s\\S]*RUN ${record.id}`));
  assert.match(output, /COPIED proof:verify/);
  assert.equal(copies.length, 1);
  assert.equal(copies[0], formatProofOutput(output));
});

function formatProofOutput(output) {
  return output.match(/PROOF CURRENT[\s\S]*?RAW run:[^\r\n]+/)?.[0] || '';
}

test('terminal evidence projection keeps stream and factual line identity visible', () => {
  const rendered = renderShellEvidenceProjection({
    runId: '20260826010101-abcd', mode: 'find', streams: [
      { stream: 'stdout', matchCount: 1, lines: [{ number: 7, text: 'needle' }] },
      { stream: 'stderr', matchCount: 0, lines: [], truncated: false },
    ],
  });
  assert.match(rendered, /SOURCE_EVIDENCE run:20260826010101-abcd · FIND/);
  assert.match(rendered, /STDOUT · 1 matches\n7: needle/);
  assert.match(rendered, /STDERR · 0 matches\n\(no matching lines\)/);
});

test('requested retained-evidence projection becomes the exact clipboard payload', () => {
  const projection = 'SOURCE_EVIDENCE run:20260826010101-abcd · HEAD\n\nSTDOUT\n1: useful';
  let displayed = '';
  let copied = '';
  const result = deliverShellProjection(projection, (value) => { displayed += value; }, (value) => { copied = value; }, 'run:20260826010101-abcd');
  assert.equal(result.copied, true);
  assert.equal(copied, projection);
  assert.match(displayed, /COPIED run:20260826010101-abcd/);

  displayed = '';
  const failure = deliverShellProjection(projection, (value) => { displayed += value; }, () => { throw new Error('clipboard unavailable'); });
  assert.equal(failure.copied, false);
  assert.match(displayed, /NOT COPIED · clipboard unavailable/);
  assert.match(displayed, /Projection remains visible above/);
});

test('Windows clipboard transport preserves Unicode evidence symbols', () => {
  const value = 'SOURCE_EVIDENCE run:test · HEAD ✓';
  const encoded = encodeClipboardInput(value, 'win32');
  assert.ok(Buffer.isBuffer(encoded));
  assert.equal(encoded.toString('utf16le'), value);
  assert.equal(encodeClipboardInput(value, 'linux'), value);
});

test('PowerShell input completeness recognizes structural continuation without executing text', () => {
  assert.equal(shellInputIncomplete('powershell', 'Write-Output ok'), false);
  assert.equal(shellInputIncomplete('powershell', 'foreach ($x in 1,2) {'), true);
  assert.equal(shellInputIncomplete('powershell', "foreach ($x in 1,2) {\n  Write-Output $x\n}"), false);
  assert.equal(shellInputIncomplete('powershell', "Write-Output 'unfinished"), true);
  assert.equal(shellInputIncomplete('powershell', 'Get-ChildItem |'), true);
  assert.equal(shellInputIncomplete('powershell', 'Write-Output `'), true);
  assert.equal(shellInputIncomplete('powershell', '<# unfinished'), true);
  assert.equal(shellInputIncomplete('powershell', '@"\nhello'), true);
  assert.equal(shellInputIncomplete('powershell', '@"\nhello\n"@'), false);
  assert.equal(shellInputIncomplete('bash', 'if true; then'), false);
});

test('terminal shell records a pasted multiline PowerShell block as one operation and rejects incomplete EOF', {
  skip: process.platform !== 'win32',
}, () => {
  const productRoot = resolve(import.meta.dirname, '..', '..');
  const root = mkdtempSync(join(tmpdir(), 'commandhud-shell-multiline-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root });
  const stateRoot = join(root, '.state');
  const script = `
    import { PassThrough } from 'node:stream';
    import { resolveProject } from ${JSON.stringify(new URL('./core.mjs', import.meta.url).href)};
    import { startHudShell } from ${JSON.stringify(new URL('./shell.mjs', import.meta.url).href)};
    const input = new PassThrough(); let output = '';
    input.end(${JSON.stringify("foreach ($x in 1,2) {\n  Write-Output $x\n}\n/exit\n")});
    const project = await resolveProject({ root: ${JSON.stringify(root)}, env: { ...process.env, HUD_STATE_ROOT: ${JSON.stringify(stateRoot)} } });
    await startHudShell(project, { input, output: { write(value) { output += value; } }, clipboardWriter() {}, visual: false });
    process.stdout.write(output);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: productRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /COMMAND foreach \(\$x in 1,2\) \{\n  Write-Output \$x\n\}/);
  assert.match(result.stdout, /STDOUT_EXCERPT\n1\n2/);
  assert.equal((result.stdout.match(/OPERATION TERMINAL-COMMAND/g) || []).length, 1);

  const incompleteScript = script.replace(
    JSON.stringify("foreach ($x in 1,2) {\n  Write-Output $x\n}\n/exit\n"),
    JSON.stringify("foreach ($x in 1,2) {\n"),
  );
  const incomplete = spawnSync(process.execPath, ['--input-type=module', '-e', incompleteScript], { cwd: productRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(incomplete.status, 0, incomplete.stderr || incomplete.stdout);
  assert.match(incomplete.stdout, /INPUT_INCOMPLETE/);
  assert.doesNotMatch(incomplete.stdout, /OPERATION TERMINAL-COMMAND/);
});

test('terminal shell renders compact measured context without replacing raw evidence', () => {
  const root = join('C:', 'fixture', 'repo');
  const project = { root };
  const record = {
    id: '20260825010101-abcd', status: 'pass', exitCode: 0, durationMs: 1250,
    branch: 'fixture', gitAfter: { branch: 'fixture' }, cwd: root,
    stdoutPath: null, stderrPath: null,
    delta: { paths: ['source.txt'] },
    operation: {
      type: 'terminal-command', shell: 'powershell', shellLabel: 'PowerShell',
      displayCommand: 'echo OK', status: 'pass', exitCode: 0, durationMs: 1250,
      cwdBefore: root, cwdAfter: root, cwdPersistence: 'unchanged', summary: ['1 check passed'],
    },
  };
  const rendered = renderShellResult(project, record);
  assert.match(rendered, /PASS · exit 0 · 1\.3s/);
  assert.match(rendered, /1 check passed/);
  assert.match(rendered, /CHANGED 1 · source\.txt/);
  assert.match(rendered, /RAW 0 B → CONTEXT \d+ B/);
  assert.match(rendered, /\/copy · \/raw · \/undo/);
});

test('terminal shell displays and copies the same shortened command context', async () => {
  const project = await shellProject();
  const root = project.root;
  const record = {
    id: '20260825010101-copy', status: 'pass', exitCode: 0, durationMs: 20,
    branch: 'fixture', gitAfter: { branch: 'fixture' }, cwd: root,
    stdoutPath: null, stderrPath: null, delta: { paths: [] },
    operation: {
      type: 'terminal-command', shell: 'powershell', shellLabel: 'PowerShell',
      displayCommand: 'echo OK', status: 'pass', exitCode: 0, durationMs: 20,
      cwdBefore: root, cwdAfter: root, cwdPersistence: 'unchanged', summary: [],
    },
  };
  let displayed = '';
  let copied = '';
  const result = await deliverShellResult(project, record, { write: (value) => { displayed += value; } }, (value) => { copied = value; });
  assert.equal(result.copied, true);
  assert.equal(copied, result.context);
  assert.match(displayed, /SHORTENED OUTPUT\nREPO commandhud-shell-project-/);
  assert.match(displayed, /EVIDENCE UNKNOWN/);
  assert.match(displayed, /COMMAND echo OK/);
  assert.match(displayed, /COPIED · run:20260825010101-copy/);
});

test('clipboard failure is visible without discarding shortened output', async () => {
  const project = await shellProject();
  const root = project.root;
  const record = {
    id: 'copy-failure', status: 'pass', exitCode: 0, durationMs: 1,
    branch: 'fixture', gitAfter: { branch: 'fixture' }, cwd: root,
    stdoutPath: null, stderrPath: null, delta: { paths: [] },
    operation: { type: 'terminal-command', shell: 'bash', shellLabel: 'Bash', displayCommand: 'true', status: 'pass', exitCode: 0, durationMs: 1, cwdBefore: root, cwdAfter: root, cwdPersistence: 'unchanged', summary: [] },
  };
  let displayed = '';
  const result = await deliverShellResult(project, record, { write: (value) => { displayed += value; } }, () => { throw new Error('clipboard unavailable'); });
  assert.equal(result.copied, false);
  assert.match(displayed, /SHORTENED OUTPUT/);
  assert.match(displayed, /NOT COPIED · clipboard unavailable/);
});

test('terminal shell keeps running when automatic clipboard delivery fails', () => {
  const productRoot = resolve(import.meta.dirname, '..', '..');
  const root = mkdtempSync(join(tmpdir(), 'commandhud-shell-copy-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root });
  const script = `
    import { PassThrough } from 'node:stream';
    import { resolveProject } from ${JSON.stringify(new URL('./core.mjs', import.meta.url).href)};
    import { startHudShell } from ${JSON.stringify(new URL('./shell.mjs', import.meta.url).href)};
    const input = new PassThrough(); let output = '';
    input.end('echo first\\n/copy\\n/exit\\n');
    const project = await resolveProject({ root: ${JSON.stringify(root)}, env: { ...process.env, HUD_STATE_ROOT: ${JSON.stringify(join(root, '.state'))} } });
    await startHudShell(project, { input, output: { write(value) { output += value; } }, clipboardWriter() { throw new Error('clipboard unavailable'); }, visual: false });
    process.stdout.write(output);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: productRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /NOT COPIED · clipboard unavailable/);
  assert.match(result.stdout, /Context remains available with \/context/);
});

test('terminal evidence request replaces clipboard while help remains UI-only', () => {
  const productRoot = resolve(import.meta.dirname, '..', '..');
  const root = mkdtempSync(join(tmpdir(), 'commandhud-shell-projection-copy-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'hud@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HUD Test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root });
  const script = `
    import { PassThrough } from 'node:stream';
    import { resolveProject } from ${JSON.stringify(new URL('./core.mjs', import.meta.url).href)};
    import { startHudShell } from ${JSON.stringify(new URL('./shell.mjs', import.meta.url).href)};
    const input = new PassThrough(); let output = ''; const copies = [];
    input.end('/help\\necho evidence\\n/head 1\\n/exit\\n');
    const project = await resolveProject({ root: ${JSON.stringify(root)}, env: { ...process.env, HUD_STATE_ROOT: ${JSON.stringify(join(root, '.state'))} } });
    await startHudShell(project, { input, output: { write(value) { output += value; } }, clipboardWriter(value) { copies.push(value); }, visual: false });
    process.stdout.write(output + '\\nCLIPBOARD_B64=' + Buffer.from(JSON.stringify(copies)).toString('base64'));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: productRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const encoded = result.stdout.match(/CLIPBOARD_B64=([^\s]+)/)?.[1];
  assert.ok(encoded, result.stdout);
  const copies = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(copies.length, 2);
  assert.match(copies[0], /OPERATION TERMINAL-COMMAND/);
  assert.doesNotMatch(copies[0], /\/help\s+show these controls/);
  assert.match(copies[1], /^SOURCE_EVIDENCE run:[^ ]+ · HEAD/);
  assert.match(copies[1], /STDOUT\n1: evidence/);
});

test('Windows repository launcher works from outside its checkout', {
  skip: process.platform !== 'win32' || !existsSync(resolve(import.meta.dirname, '..', '..', 'CommandHUD Shell.cmd')),
}, () => {
  const productRoot = resolve(import.meta.dirname, '..', '..');
  const launcher = join(productRoot, 'CommandHUD Shell.cmd');
  const root = mkdtempSync(join(tmpdir(), 'commandhud-launcher-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  const result = spawnSync('cmd.exe', ['/d', '/c', launcher], {
    cwd: root, input: '/cwd\r\n/exit\r\n', encoding: 'utf8', timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /hate\.this\.meaningless\.life · context condenser/);
  assert.match(result.stdout, /Repository: commandhud-launcher-/);
  assert.match(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});
