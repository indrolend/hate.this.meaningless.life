import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deliverShellResult, parseShellEvidenceCommand, renderShellEvidenceProjection, renderShellResult } from './shell.mjs';

test('terminal evidence commands target the latest or an explicit immutable run', () => {
  const runId = '20260826010101-abcd';
  const older = '20260825020202-1234';
  assert.deepEqual(parseShellEvidenceCommand('/head 12', runId), { runId, mode: 'head', count: '12' });
  assert.deepEqual(parseShellEvidenceCommand(`/tail ${older} 5`, runId), { runId: older, mode: 'tail', count: '5' });
  assert.deepEqual(parseShellEvidenceCommand('/find exact useful text', runId), { runId, mode: 'find', pattern: 'exact useful text' });
  assert.deepEqual(parseShellEvidenceCommand(`/around ${older} failure 3`, runId), { runId: older, mode: 'around', pattern: 'failure', context: '3' });
  assert.throws(() => parseShellEvidenceCommand('/raw', null), /No command has been recorded/);
});

test('terminal evidence projection keeps stream and factual line identity visible', () => {
  const rendered = renderShellEvidenceProjection({
    runId: '20260826010101-abcd', mode: 'find', streams: [
      { stream: 'stdout', matchCount: 1, lines: [{ number: 7, text: 'needle' }] },
      { stream: 'stderr', matchCount: 0, lines: [], truncated: false },
    ],
  });
  assert.match(rendered, /STDOUT · 1 matches\n7: needle/);
  assert.match(rendered, /STDERR · 0 matches\n\(no matching lines\)/);
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

test('terminal shell displays and copies the same shortened command context', () => {
  const root = join('C:', 'fixture', 'repo');
  const project = { root };
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
  const result = deliverShellResult(project, record, { write: (value) => { displayed += value; } }, (value) => { copied = value; });
  assert.equal(result.copied, true);
  assert.equal(copied, result.context);
  assert.match(displayed, /SHORTENED OUTPUT\nREPO repo/);
  assert.match(displayed, /COMMAND echo OK/);
  assert.match(displayed, /COPIED · run:20260825010101-copy/);
});

test('clipboard failure is visible without discarding shortened output', () => {
  const root = join('C:', 'fixture', 'repo');
  const record = {
    id: 'copy-failure', status: 'pass', exitCode: 0, durationMs: 1,
    branch: 'fixture', gitAfter: { branch: 'fixture' }, cwd: root,
    stdoutPath: null, stderrPath: null, delta: { paths: [] },
    operation: { type: 'terminal-command', shell: 'bash', shellLabel: 'Bash', displayCommand: 'true', status: 'pass', exitCode: 0, durationMs: 1, cwdBefore: root, cwdAfter: root, cwdPersistence: 'unchanged', summary: [] },
  };
  let displayed = '';
  const result = deliverShellResult({ root }, record, { write: (value) => { displayed += value; } }, () => { throw new Error('clipboard unavailable'); });
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
