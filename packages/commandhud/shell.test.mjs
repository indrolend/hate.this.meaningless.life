import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deliverShellResult, renderShellResult } from './shell.mjs';

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

test('Windows repository launcher works from outside its checkout', {
  skip: process.platform !== 'win32' || !existsSync(resolve(import.meta.dirname, '..', '..', 'CommandHUD Shell.cmd')),
}, () => {
  const root = resolve(import.meta.dirname, '..', '..');
  const launcher = join(root, 'CommandHUD Shell.cmd');
  const result = spawnSync('cmd.exe', ['/d', '/c', launcher], {
    cwd: tmpdir(), input: '/cwd\r\n/exit\r\n', encoding: 'utf8', timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /hate\.this\.meaningless\.life · context condenser/);
  assert.match(result.stdout, /Repository: digital-breakdown-apk · Shell: PowerShell/);
  assert.match(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});
