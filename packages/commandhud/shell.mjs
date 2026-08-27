import { spawnSync } from 'node:child_process';
import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import {
  buildCurrentOperationContext, buildOperationContext, diffRunEvidence, discoverShells, formatRepositoryCommandProof, lastRun, listRuns, projectRunEvidence, repositoryCommandProof, runById,
  runTerminalCommand, undoOperation, undoPlan,
} from './core.mjs';
import { createShellVisualStatus, IDLE_FACE, visualMotionEnabled } from './shell-visual.mjs';
import { createShellLayout, splitMouseInput } from './shell-layout.mjs';

export function encodeClipboardInput(text, targetPlatform = process.platform) {
  return targetPlatform === 'win32' ? Buffer.from(String(text), 'utf16le') : String(text);
}

function clipboard(text) {
  const tool = process.platform === 'win32' ? ['clip.exe', []]
    : process.platform === 'darwin' ? ['pbcopy', []]
      : ['sh', ['-c', 'command -v wl-copy >/dev/null && wl-copy || xclip -selection clipboard']];
  const result = spawnSync(tool[0], tool[1], { input: encodeClipboardInput(text), windowsHide: true });
  if (result.status !== 0) throw new Error('Clipboard tool is unavailable.');
}

function displayCwd(project, cwd) {
  return relative(project.root, cwd).replaceAll('\\', '/') || '.';
}

export function shellInputIncomplete(shell, value) {
  if (shell !== 'powershell') return false;
  const text = String(value || '').replace(/\r\n?/g, '\n');
  const stack = [];
  let quote = null;
  let blockComment = false;
  let hereString = null;
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closing = new Set(Object.values(pairs));
  const lines = text.split('\n');
  for (const line of lines) {
    if (hereString) {
      if (line.trim() === `${hereString}@`) hereString = null;
      continue;
    }
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      const next = line[index + 1];
      if (blockComment) {
        if (character === '#' && next === '>') { blockComment = false; index++; }
        continue;
      }
      if (quote) {
        if (quote === "'" && character === "'" && next === "'") { index++; continue; }
        if (quote === '"' && character === '`') { index++; continue; }
        if (character === quote) quote = null;
        continue;
      }
      if (character === '<' && next === '#') { blockComment = true; index++; continue; }
      if (character === '#') break;
      if (character === '@' && (next === '"' || next === "'") && !line.slice(index + 2).trim()) {
        hereString = next;
        break;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '`') { index++; continue; }
      if (pairs[character]) stack.push(pairs[character]);
      else if (closing.has(character) && stack.at(-1) === character) stack.pop();
    }
  }
  const tail = lines.at(-1).trimEnd();
  return Boolean(hereString || blockComment || quote || stack.length || /(?:`|\||,)\s*$/.test(tail));
}

export function parseShellEvidenceCommand(command, fallbackRunId) {
  const match = String(command || '').match(/^\/(raw|head|tail|find|around)(?:\s+(.*))?$/);
  if (!match) return null;
  const mode = match[1];
  const parts = match[2]?.trim().split(/\s+/).filter(Boolean) || [];
  const isRunId = (value) => /^\d{14}-[0-9a-f]{4}$/i.test(value || '');
  let runId = isRunId(parts[0]) ? parts.shift() : fallbackRunId;
  if ((mode === 'head' || mode === 'tail') && /^\d+$/.test(parts[0] || '') && isRunId(parts[1])) {
    const count = parts.shift();
    runId = parts.shift();
    if (parts.length) throw new Error(`Syntax: /${mode} <run> [count]`);
    return { runId, mode, count };
  }
  if (!runId) throw new Error('No command has been recorded yet.');
  if (mode === 'raw') {
    if (parts.length) throw new Error('Syntax: /raw <run>');
    return { runId, mode };
  }
  if (mode === 'head' || mode === 'tail') {
    if (parts.length > 1 || (parts[0] && !/^\d+$/.test(parts[0]))) throw new Error(`Syntax: /${mode} <run> [count]`);
    return { runId, mode, count: parts[0] };
  }
  if (mode === 'find') {
    if (!parts.length) throw new Error('Syntax: /find <run> <pattern>');
    return { runId, mode, pattern: parts.join(' ') };
  }
  const context = /^\d+$/.test(parts.at(-1) || '') ? parts.pop() : undefined;
  if (!parts.length) throw new Error('Syntax: /around <run> <pattern> [lines]');
  return { runId, mode, pattern: parts.join(' '), context };
}

export function renderShellEvidenceProjection(value) {
  const lines = [`SOURCE_EVIDENCE run:${value.runId} · ${value.mode.toUpperCase()}`];
  for (const stream of value.streams) {
    lines.push('', `${stream.stream.toUpperCase()}${stream.matchCount === undefined ? '' : ` · ${stream.matchCount} matches`}`);
    if (value.mode === 'raw') lines.push(stream.content || '(empty)');
    else lines.push(...(stream.lines.length ? stream.lines.map((line) => `${line.number}: ${line.text}`) : ['(no matching lines)']));
    if (stream.truncated) lines.push('… additional matching context retained in raw evidence');
  }
  return lines.join('\n').trimEnd();
}

export function deliverShellProjection(value, show, clipboardWriter = clipboard, source = 'evidence') {
  show(`${value}\n\n`);
  try {
    clipboardWriter(value);
    show(`COPIED ${source}\n\n`);
    return { value, copied: true };
  } catch (error) {
    show(`NOT COPIED · ${error.message}\nProjection remains visible above.\n\n`);
    return { value, copied: false };
  }
}

export function renderShellResult(project, record, suppliedContext = null) {
  const operation = record.operation;
  const context = suppliedContext || buildOperationContext(project, record);
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

export async function deliverShellResult(project, record, output, clipboardWriter = clipboard) {
  const currentContext = await buildCurrentOperationContext(project, record);
  const context = currentContext.handoff;
  output.write(`${renderShellResult(project, record, currentContext)}\n\nSHORTENED OUTPUT\n${context}\n`);
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
    '/copy [run]    copy compact context for the latest or selected run',
    '/context [run] print compact context for the latest or selected run',
    '/raw           print complete stdout and stderr',
    '/head [n]      show the first recorded lines without rerunning',
    '/tail [n]      show the last recorded lines without rerunning',
    '/find <text>   find literal text in recorded evidence',
    '/around <text> [n]  show recorded lines around matches',
    '/diff <run> <run>  compare two retained stdout/stderr records',
    'Add a run ID after the command to inspect an older run.',
    '/history [n]   list a bounded number of recorded operations',
    '/proof <name>  reuse current repository-command evidence without executing',
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
  tui = false,
} = {}) {
  let restoreOutputTrace = () => {};
  if (process.env.COMMANDHUD_TRACE_WRITES === '1') {
    const tracePath = `${process.env.TEMP || process.env.TMP || process.cwd()}\\commandhud-write-trace.jsonl`;
    const { appendFileSync, writeFileSync } = await import('node:fs');
    const originalOutputWrite = output.write;
    let outputWriteSequence = 0;
    try { writeFileSync(tracePath, '', 'utf8'); } catch {}
    output.write = function tracedOutputWrite(chunk, ...args) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const caller = new Error().stack?.split('\n').slice(2, 6).map((line) => line.trim()).join(' <- ') || '';
      try {
        appendFileSync(tracePath, `${JSON.stringify({
          sequence: ++outputWriteSequence, rows: Number(output.rows) || null,
          columns: Number(output.columns) || null, text, caller,
        })}\n`, 'utf8');
      } catch {}
      return originalOutputWrite.call(this, chunk, ...args);
    };
    restoreOutputTrace = () => { output.write = originalOutputWrite; };
  }

  const available = await discoverShells(project.root);
  let shell = available.find((entry) => entry.id === requestedShell && entry.available);
  if (!shell) throw new Error(`Terminal shell is unavailable: ${requestedShell}`);
  let cwd = project.root;
  let activeController = null;
  const interactive = Boolean(input.isTTY && output.isTTY);
  const motion = visualMotionEnabled({ interactive, requested: visual && tui });
  const layout = createShellLayout(output, { enabled: interactive && tui });
  const filteredInput = interactive && tui ? new PassThrough() : input;
  if (filteredInput !== input) {
    filteredInput.isTTY = true;
    filteredInput.setRawMode = (mode) => input.setRawMode?.(mode);
  }
  const terminal = createInterface({ input: filteredInput, output, terminal: interactive });
  const commandLines = terminal[Symbol.asyncIterator]();
  if (layout.active === false && interactive && tui) layout.start();
  if (!layout.active) {
    output.write(`${IDLE_FACE} hate.this.meaningless.life · context condenser\n`);
    output.write(`Repository: ${basename(project.root)} · Shell: ${shell.label} · /help for controls\n\n`);
  }

  const show = (value) => layout.active ? layout.renderOutput(String(value).trimEnd()) : output.write(value);

  const inputHandler = (chunk) => {
    if (!layout.active) return;
    const parsed = splitMouseInput(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    for (const event of parsed.events) {
      const action = layout.actionAt(event.column, event.row);
      layout.setHover(action);
      if (event.button !== 0 || event.phase !== 'M' || !action) continue;
      if (terminal.line) {
        show('Finish or clear the current command before using a mouse action.');
        continue;
      }
      terminal.write(action);
      terminal.write(null, { name: 'return' });
    }
    if (parsed.text) filteredInput.write(parsed.text);
  };
  if (layout.active) input.on('data', inputHandler);

  terminal.on('SIGINT', () => {
    if (activeController) activeController.abort();
    else terminal.close();
  });
  try {
    while (true) {
      let command;
      try {
        if (interactive) {
          const prompt = layout.active ? '> ' : '> ';
          if (layout.active) layout.placePrompt(prompt);
          else output.write(prompt);
        }
        const next = await commandLines.next();
        if (layout.active) layout.clearPrompt();
        if (next.done) break;
        command = next.value;
        if (!interactive) output.write(`${shell.id} ${displayCwd(project, cwd)}> ${command}\n`);
      }
      catch { break; }
      while (shellInputIncomplete(shell.id, command)) {
        let continuation = null;
        try {
          if (interactive && layout.active) layout.placePrompt('... ');
          else if (interactive) output.write('... ');
          const next = await commandLines.next();
          if (layout.active) layout.clearPrompt();
          if (!next.done) {
            continuation = next.value;
            if (!interactive) output.write(`... ${continuation}\n`);
          }
        } catch {}
        if (continuation === null) {
          show('INPUT_INCOMPLETE\nPowerShell block ended before its syntax was complete. Nothing was executed.\n\n');
          command = '';
          break;
        }
        command += `\n${continuation}`;
        if (command.length > 32 * 1024) {
          show('INPUT_REJECTED\nMultiline command exceeds 32 KiB. Nothing was executed.\n\n');
          command = '';
          break;
        }
      }
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
      if (/^\/proof(?:\s|$)/.test(command)) {
        const parts = command.split(/\s+/).filter(Boolean);
        if (parts.length !== 2) show('/proof requires exactly one repository command name.\n\n');
        else {
          try {
            const proof = await repositoryCommandProof(project, parts[1]);
            deliverShellProjection(formatRepositoryCommandProof(proof), show, clipboardWriter, `proof:${parts[1]}`);
          } catch (error) { show(`${error.message}\n\n`); }
        }
        continue;
      }
      const previous = lastRun(project);
      if (/^\/(?:copy|context)(?:\s|$)/.test(command)) {
        const [action, requested] = command.split(/\s+/, 2);
        const selected = requested ? runById(project, requested) : previous;
        if (!selected?.operation) show(`${requested ? `No structured run found for ${requested}.` : 'No structured command has been recorded yet.'}\n\n`);
        else {
          const value = (await buildCurrentOperationContext(project, selected)).handoff;
          if (action === '/copy') {
            try { clipboardWriter(value); show(`COPIED run:${selected.id}\n\n${value}`); }
            catch (error) { show(`NOT COPIED · ${error.message}\nContext remains available with /context ${selected.id}.\n\n`); }
          }
          else show(`${value}\n\n`);
        }
        continue;
      }
      if (/^\/(?:raw|head|tail|find|around)(?:\s|$)/.test(command)) {
        try {
          const request = parseShellEvidenceCommand(command, previous?.id);
          const value = projectRunEvidence(project, request.runId, request);
          deliverShellProjection(renderShellEvidenceProjection(value), show, clipboardWriter, `run:${request.runId}`);
        } catch (error) { show(`${error.message}\n\n`); }
        continue;
      }
      if (/^\/diff(?:\s|$)/.test(command)) {
        const [, left, right] = command.split(/\s+/, 3);
        if (!left || !right) show('/diff requires two recorded run IDs.\n\n');
        else {
          try {
            const value = await diffRunEvidence(project, left, right);
            const lines = [`SOURCE_EVIDENCE runs:${left},${right} · DIFF`, `DIFFERENT ${value.different}`];
            for (const stream of value.streams) {
              lines.push('', `${stream.stream.toUpperCase()} ${stream.different ? 'CHANGED' : 'UNCHANGED'}`);
              if (stream.text) lines.push(stream.text);
              if (stream.truncated) lines.push('… complete evidence remains in both runs');
            }
            deliverShellProjection(lines.join('\n'), show, clipboardWriter, `runs:${left},${right}`);
          } catch (error) { show(`${error.message}\n\n`); }
        }
        continue;
      }
      if (/^\/history(?:\s|$)/.test(command)) {
        const requested = command.split(/\s+/, 2)[1];
        const count = requested === undefined ? 10 : Number(requested);
        if (!Number.isInteger(count) || count < 1 || count > 100) show('/history requires a count from 1 to 100.\n\n');
        else show(`${listRuns(project, count).map((run) => `${run.id} ${run.status.toUpperCase()} ${run.operation?.displayCommand || run.command}`).join('\n') || '(no recorded runs)'}\n\n`);
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
          const record = await undoOperation(project, target.id, { origin: 'terminal-ui' });
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
          shell: shell.id, cwd, stream: false, signal: activeController.signal, origin: 'terminal-ui',
        });
        await visualStatus.finish(record.status);
        cwd = record.operation.cwdAfter;
        if (layout.active) {
          const context = (await buildCurrentOperationContext(project, record)).handoff;
          let copyState;
          try { clipboardWriter(context); copyState = `COPIED · run:${record.id}`; }
          catch (error) { copyState = `NOT COPIED · ${error.message} · use /copy to retry`; }
          show(`SHORTENED OUTPUT\n${context}\n\n${copyState}`);
        } else await deliverShellResult(project, record, output, clipboardWriter);
      } catch (error) {
        await visualStatus.finish(error.name === 'AbortError' ? 'interrupted' : 'fail');
        show(`ERROR · ${error.message}\n\n`);
      } finally {
        visualStatus.clear();
        activeController = null;
      }
    }
  } finally {
    input.removeListener('data', inputHandler);
    if (filteredInput !== input) filteredInput.end();
    terminal.close();
    layout.finish();
    restoreOutputTrace();
  }
}
