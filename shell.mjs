import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  buildOperationContext, discoverShells, lastRun, listRuns,
  runTerminalCommand, undoOperation, undoPlan,
} from './core.mjs';
import { createShellVisualStatus, IDLE_FACE, visualMotionEnabled } from './shell-visual.mjs';
import { createShellLayout } from './shell-layout.mjs';

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
  visual = true,
  tui = true,
} = {}) {
  const available = await discoverShells(project.root);
  let shell = available.find((entry) => entry.id === requestedShell && entry.available);
  if (!shell) throw new Error(`Terminal shell is unavailable: ${requestedShell}`);
  let cwd = project.root;
  let activeController = null;
  const interactive = Boolean(input.isTTY && output.isTTY);
  const motion = visualMotionEnabled({ interactive, requested: visual });
  const layout = createShellLayout(output, { enabled: interactive && tui });
  const terminal = createInterface({ input, output, terminal: interactive });
  const pipedCommands = interactive ? null : terminal[Symbol.asyncIterator]();
  if (layout.active === false && interactive && tui) layout.start();
  if (!layout.active) {
    output.write(`${IDLE_FACE} CommandHUD · ${shell.label} · ${basename(project.root)}\n`);
    output.write('Paste a command. Shortened output is shown and copied automatically; full evidence is retained. /help for controls.\n\n');
  }

  const show = (value) => layout.active ? layout.renderOutput(String(value).trimEnd()) : output.write(value);
  let currentPrompt = '';

  const mouseHandler = (chunk) => {
    if (!layout.active) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const button = Number(match[1]);
      const action = layout.actionAt(Number(match[2]), Number(match[3]));
      layout.setHover(action);
      if (button !== 0 || match[4] !== 'M' || !action) {
        setImmediate(() => {
          const cleaned = String(terminal.line || '').replace(/<?\d+;\d+;\d+[Mm]/g, '');
          if (cleaned === terminal.line) return;
          terminal.line = cleaned;
          terminal.cursor = cleaned.length;
          if (layout.active) layout.placePrompt(`${currentPrompt}${cleaned}`);
        });
        continue;
      }
      if (terminal.line) {
        show('Finish or clear the current command before using a mouse action.');
        continue;
      }
      terminal.write(action);
      terminal.write(null, { name: 'return' });
      setImmediate(() => {
        if (!layout.active) return;
        const cleaned = String(terminal.line || '').replace(/<?\d+;\d+;\d+[Mm]/g, '');
        if (cleaned === terminal.line) return;
        terminal.line = cleaned;
        terminal.cursor = cleaned.length;
        layout.placePrompt(`${currentPrompt}${cleaned}`);
      });
    }
  };
  if (layout.active) input.prependListener('data', mouseHandler);

  terminal.on('SIGINT', () => {
    if (activeController) activeController.abort();
    else terminal.close();
  });
  try {
    while (true) {
      let command;
      try {
        if (interactive) {
          const prompt = `${shell.id} ${displayCwd(project, cwd)}> `;
          currentPrompt = prompt;
          if (layout.active) layout.placePrompt(prompt);
          command = await terminal.question(layout.active ? '' : `${IDLE_FACE} ${prompt}`);
          layout.clearPrompt();
        }
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
      if (command === '/help') { show(`${help()}\n\n`); continue; }
      if (command === '/cwd') { show(`${cwd}\n\n`); continue; }
      if (command.startsWith('/shell')) {
        const id = command.split(/\s+/, 2)[1];
        const selected = available.find((entry) => entry.id === id && entry.available);
        if (!selected) show(`Unavailable shell: ${id || '(missing)'}\n\n`);
        else { shell = selected; layout.updateShell(shell.label); show(`SHELL ${shell.label}\n\n`); }
        continue;
      }
      const previous = lastRun(project);
      if (command === '/copy' || command === '/context') {
        if (!previous?.operation) show('No structured command has been recorded yet.\n\n');
        else {
          const value = buildOperationContext(project, previous).handoff;
          if (command === '/copy') { clipboardWriter(value); show(`COPIED run:${previous.id}\n\n${value}`); }
          else show(`${value}\n\n`);
        }
        continue;
      }
      if (command === '/raw') {
        if (!previous) show('No command has been recorded yet.\n\n');
        else {
          const stdout = previous.stdoutPath ? readFileSync(previous.stdoutPath, 'utf8') : '';
          const stderr = previous.stderrPath ? readFileSync(previous.stderrPath, 'utf8') : '';
          show(`${stdout}${stdout && stderr ? '\n' : ''}${stderr}\n`);
        }
        continue;
      }
      if (command === '/history') {
        show(`${listRuns(project, 10).map((run) => `${run.id} ${run.status.toUpperCase()} ${run.operation?.displayCommand || run.command}`).join('\n')}\n\n`);
        continue;
      }
      if (command.startsWith('/undo')) {
        const requested = command.split(/\s+/, 2)[1];
        const target = requested ? listRuns(project, 100).find((run) => run.id === requested) : previous;
        if (!target) { show('No recorded command is available for Undo.\n\n'); continue; }
        const plan = await undoPlan(project, target.id);
        const planLines = [`UNDO ${plan.state} · run:${target.id}`, plan.reason, ...plan.paths];
        if (!requested && plan.state === 'SAFE') planLines.push(`Apply explicitly with /undo ${target.id}`);
        if (!requested && plan.state === 'SAFE') show(`${planLines.join('\n')}\n\n`);
        else if (requested && plan.state === 'SAFE') {
          const record = await undoOperation(project, target.id);
          show(`${renderShellResult(project, record)}\n\n`);
        } else show(`${planLines.join('\n')}\n\n`);
        continue;
      }
      activeController = new AbortController();
      const visualStatus = createShellVisualStatus(output, {
        enabled: layout.active || motion, animated: motion, row: layout.active ? 2 : null, showFace: !layout.active,
      });
      try {
        visualStatus.start(command);
        const record = await runTerminalCommand(project, command, {
          shell: shell.id, cwd, stream: false, signal: activeController.signal,
        });
        await visualStatus.finish(record.status);
        cwd = record.operation.cwdAfter;
        if (layout.active) {
          const context = buildOperationContext(project, record).handoff;
          let copyState;
          try { clipboardWriter(context); copyState = `COPIED · run:${record.id}`; }
          catch (error) { copyState = `NOT COPIED · ${error.message} · use /copy to retry`; }
          show(`SHORTENED OUTPUT\n${context}\n\n${copyState}`);
        } else deliverShellResult(project, record, output, clipboardWriter);
      } catch (error) {
        await visualStatus.finish(error.name === 'AbortError' ? 'interrupted' : 'fail');
        show(`ERROR · ${error.message}\n\n`);
      } finally {
        visualStatus.clear();
        activeController = null;
      }
    }
  } finally {
    input.removeListener('data', mouseHandler);
    terminal.close();
    layout.finish();
  }
}
