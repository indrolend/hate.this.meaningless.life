import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  buildOperationContext, discoverShells, lastRun, listRuns,
  runTerminalCommand, undoOperation, undoPlan,
} from './core.mjs';

function clipboard(text) {
  const tool = process.platform === 'win32' ? ['clip.exe', []]
    : process.platform === 'darwin' ? ['pbcopy', []]
      : ['sh', ['-c', 'command -v wl-copy >/dev/null && wl-copy || xclip -selection clipboard']];
  const result = spawnSync(tool[0], tool[1], { input: text, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Clipboard tool is unavailable.');
}

function displayCwd(project, cwd) {
  return relative(project.root, cwd).replaceAll('\\', '/') || '.';
}

export function renderShellResult(project, record) {
  const operation = record.operation;
  const context = buildOperationContext(project, record);
  const lines = [
    `${record.status.toUpperCase()} · exit ${record.exitCode ?? 'none'} · ${(record.durationMs / 1000).toFixed(1)}s`,
  ];
  if (operation?.summary?.length) lines.push(operation.summary.join(' · '));
  if (record.delta?.paths?.length) lines.push(`CHANGED ${record.delta.paths.length} · ${record.delta.paths.join(', ')}`);
  const metrics = context.metrics;
  lines.push(`RAW ${metrics.rawBytes} B → CONTEXT ${metrics.contextBytes} B · ${metrics.reductionPercent}% shorter`);
  lines.push(`RUN ${record.id} · /copy · /raw · /undo`);
  return lines.join('\n');
}

export function deliverShellResult(project, record, output, clipboardWriter = clipboard) {
  const context = buildOperationContext(project, record).handoff;
  output.write(`${renderShellResult(project, record)}\n\nSHORTENED OUTPUT\n${context}\n`);
  try {
    clipboardWriter(context);
    output.write(`\nCOPIED · run:${record.id}\n\n`);
    return { context, copied: true };
  } catch (error) {
    output.write(`\nNOT COPIED · ${error.message}\nUse /copy to try again.\n\n`);
    return { context, copied: false };
  }
}

function help() {
  return [
    '/copy          copy compact context for the last command again',
    '/context       print compact context for the last command',
    '/raw           print complete stdout and stderr',
    '/history       list the 10 latest recorded operations',
    '/undo          inspect the latest command for safe Undo',
    '/undo <run>    apply a previously inspected safe Undo',
    '/shell <id>    switch to powershell, bash, or cmd',
    '/cwd           show the persistent repository directory',
    '/help          show these controls',
    '/exit          leave CommandHUD',
  ].join('\n');
}

export async function startHudShell(project, {
  shell: requestedShell = process.platform === 'win32' ? 'powershell' : 'bash',
  input = process.stdin, output = process.stdout,
  clipboardWriter = clipboard,
} = {}) {
  const available = await discoverShells(project.root);
  let shell = available.find((entry) => entry.id === requestedShell && entry.available);
  if (!shell) throw new Error(`Terminal shell is unavailable: ${requestedShell}`);
  let cwd = project.root;
  let activeController = null;
  const interactive = Boolean(input.isTTY && output.isTTY);
  const terminal = createInterface({ input, output, terminal: interactive });
  const pipedCommands = interactive ? null : terminal[Symbol.asyncIterator]();
  output.write(`CommandHUD · ${shell.label} · ${basename(project.root)}\n`);
  output.write('Paste a command. Shortened output is shown and copied automatically; full evidence is retained. /help for controls.\n\n');

  terminal.on('SIGINT', () => {
    if (activeController) activeController.abort();
    else terminal.close();
  });
  try {
    while (true) {
      let command;
      try {
        if (interactive) command = await terminal.question(`${shell.id} ${displayCwd(project, cwd)}> `);
        else {
          const next = await pipedCommands.next();
          if (next.done) break;
          command = next.value;
          output.write(`${shell.id} ${displayCwd(project, cwd)}> ${command}\n`);
        }
      }
      catch { break; }
      command = command.trim();
      if (!command) continue;
      if (command === '/exit' || command === '/quit') break;
      if (command === '/help') { output.write(`${help()}\n\n`); continue; }
      if (command === '/cwd') { output.write(`${cwd}\n\n`); continue; }
      if (command.startsWith('/shell')) {
        const id = command.split(/\s+/, 2)[1];
        const selected = available.find((entry) => entry.id === id && entry.available);
        if (!selected) output.write(`Unavailable shell: ${id || '(missing)'}\n\n`);
        else { shell = selected; output.write(`SHELL ${shell.label}\n\n`); }
        continue;
      }
      const previous = lastRun(project);
      if (command === '/copy' || command === '/context') {
        if (!previous?.operation) output.write('No structured command has been recorded yet.\n\n');
        else {
          const value = buildOperationContext(project, previous).handoff;
          if (command === '/copy') { clipboardWriter(value); output.write(`COPIED run:${previous.id}\n\n`); }
          else output.write(`${value}\n\n`);
        }
        continue;
      }
      if (command === '/raw') {
        if (!previous) output.write('No command has been recorded yet.\n\n');
        else {
          const stdout = previous.stdoutPath ? readFileSync(previous.stdoutPath, 'utf8') : '';
          const stderr = previous.stderrPath ? readFileSync(previous.stderrPath, 'utf8') : '';
          output.write(`${stdout}${stdout && stderr ? '\n' : ''}${stderr}\n`);
        }
        continue;
      }
      if (command === '/history') {
        for (const run of listRuns(project, 10)) output.write(`${run.id} ${run.status.toUpperCase()} ${run.operation?.displayCommand || run.command}\n`);
        output.write('\n');
        continue;
      }
      if (command.startsWith('/undo')) {
        const requested = command.split(/\s+/, 2)[1];
        const target = requested ? listRuns(project, 100).find((run) => run.id === requested) : previous;
        if (!target) { output.write('No recorded command is available for Undo.\n\n'); continue; }
        const plan = await undoPlan(project, target.id);
        output.write(`UNDO ${plan.state} · run:${target.id}\n${plan.reason}\n`);
        if (plan.paths.length) output.write(`${plan.paths.join('\n')}\n`);
        if (!requested && plan.state === 'SAFE') output.write(`Apply explicitly with /undo ${target.id}\n\n`);
        else if (requested && plan.state === 'SAFE') {
          const record = await undoOperation(project, target.id);
          output.write(`${renderShellResult(project, record)}\n\n`);
        } else output.write('\n');
        continue;
      }
      activeController = new AbortController();
      try {
        const record = await runTerminalCommand(project, command, {
          shell: shell.id, cwd, stream: false, signal: activeController.signal,
        });
        cwd = record.operation.cwdAfter;
        deliverShellResult(project, record, output, clipboardWriter);
      } catch (error) {
        output.write(`ERROR · ${error.message}\n\n`);
      } finally {
        activeController = null;
      }
    }
  } finally {
    terminal.close();
  }
}
