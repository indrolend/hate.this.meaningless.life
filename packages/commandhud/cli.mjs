#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatPacket, resolveProject, gitSnapshot, repositoryCurrency, repositoryTree, diffRunEvidence, discoverCommands, discoverTools, runCommand, runRepositoryCommand, searchRepository, buildCurrentOperationContext, filesystemIdentity, inspectRuntimeAuthority, lastRun, listRuns, observeWindowsService, planWindowsServiceReset, projectRunEvidence, recordFilesystemComparison, runById, fetchUpdate, continuation, setWorkingValue, undoOperation, undoPlan, workingValue, workflowView, buildWorkflowPacket, currentState } from './core.mjs';

const HELP = `hate.this.meaningless.life · context condenser

Run from any Git repository:
  hud shell                         interactive terminal + compact clipboard result
  hud run -- <command>              record one command and print a compact packet
  hud state [--json]                current repository and last-operation state
  hud search <query> [scope]        recorded ripgrep search
  hud tools                         discovered tools and repository commands
  hud repository-command <name>    run a repository-owned typed command

Retained evidence (never reruns the command):
  hud history [count]
  hud handoff [--copy]
  hud raw|head|tail <run> [count]
  hud find <run> <pattern>
  hud around <run> <pattern> [lines]
  hud diff <run-a> <run-b>
  hud copy <run>

Safety and authority:
  hud runtime                       executing/source authority and duplicate check
  hud undo-plan <run>               inspect whether a worktree reversal is safe
  hud undo <run>                    apply an evidence-backed worktree reversal
  hud file-identity <path>
  hud compare-files <left> <right>

Other clients:
  hud desktop                       Windows app window
  hud serve                         loopback typed-operation server

Use --root <path> to select an explicit Git repository.`;

function parse(argv) {
  const args = [...argv];
  const options = { copy: false, quiet: false, root: null, shell: null, animation: true, tui: false, objective: null, request: null, requestB64: null, workflowId: null, workflowName: null, stage: null, stageIndex: null, stageCount: null, json: false, host: '127.0.0.1', port: 8765 };
  const command = args.shift() || 'context';
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') { positionals.push(...args.slice(index + 1)); break; }
    if (value === '--copy' || value === '--copy-packet') options.copy = true;
    else if (value === '--no-animation') options.animation = false;
    else if (value === '--plain') options.tui = false;
    else if (value === '--tui') options.tui = true;
    else if (value === '--quiet') options.quiet = true;
    else if (value === '--json') options.json = true;
    else if (value === '--lan') options.host = '0.0.0.0';
    else if (value === '--host') options.host = args[++index];
    else if (value === '--port') options.port = Number(args[++index]);
    else if (value === '--root' || value === '--shell' || value === '--objective' || value === '--request') options[value.slice(2)] = args[++index];
    else if (value === '--request-b64') options.requestB64 = args[++index];
    else if (value === '--workflow-id') options.workflowId = args[++index];
    else if (value === '--workflow-name') options.workflowName = args[++index];
    else if (value === '--stage') options.stage = args[++index];
    else if (value === '--stage-index') options.stageIndex = Number(args[++index]);
    else if (value === '--stage-count') options.stageCount = Number(args[++index]);
    else if (command === 'run') { positionals.push(...args.slice(index)); break; }
    else positionals.push(value);
  }
  return { command, args: positionals, options };
}

function printObject(object) {
  for (const [key, value] of Object.entries(object)) {
    const rendered = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    console.log(`${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}=${rendered}`);
  }
}

function copy(text) {
  const tool = process.platform === 'win32' ? ['clip.exe', []]
    : process.platform === 'darwin' ? ['pbcopy', []] : ['sh', ['-c', 'command -v wl-copy >/dev/null && wl-copy || xclip -selection clipboard']];
  const result = spawnSync(tool[0], tool[1], { input: text, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Clipboard tool is unavailable. Packet was still printed.');
}

function printEvidenceProjection(value) {
  console.log(`RUN ${value.runId}`);
  console.log(`STATUS ${value.status.toUpperCase()} exit=${value.exitCode}`);
  console.log(`COMMAND ${value.command}`);
  for (const stream of value.streams) {
    console.log(`\n${stream.stream.toUpperCase()}${stream.matchCount === undefined ? '' : ` matches=${stream.matchCount}`}`);
    if (value.mode === 'raw') process.stdout.write(stream.content.endsWith('\n') || !stream.content ? stream.content : `${stream.content}\n`);
    else for (const line of stream.lines) console.log(`${line.number}: ${line.text}`);
    if (stream.truncated) console.log(`[bounded: additional matching context retained in raw evidence]`);
  }
}

async function context(project, json) {
  const [git, tools] = await Promise.all([gitSnapshot(project.root), discoverTools()]);
  let update;
  try { update = await fetchUpdate(project); } catch (error) { update = { status: 'unknown', error: error.message }; }
  const previous = lastRun(project);
  const value = {
    project: project.identity.id, root: project.root, branch: git.branch, head: git.head,
    upstream: git.upstream || 'none', dirty: git.dirty, ahead: git.ahead ?? 'unknown', behind: git.behind ?? 'unknown',
    platform: process.platform === 'win32' ? 'windows-x64' : `${process.platform}-${process.arch}`,
    tools, commands: discoverCommands(project.root), distribution: update,
    lastRun: previous ? { id: previous.id, objective: previous.objective || previous.command, status: previous.status } : null,
    frontier: previous?.packet?.FRONTIER || 'select the first bounded objective',
  };
  if (json) return console.log(JSON.stringify(value, null, 2));
  printObject({ PROJECT: value.project, ROOT: value.root, BRANCH: value.branch, HEAD: value.head, UPSTREAM: value.upstream, DIRTY: value.dirty, PLATFORM: value.platform });
  console.log('TOOLS'); for (const [name, version] of Object.entries(tools)) console.log(`${name}=${version}`);
  const contextCommands = new Set(['npm:test', 'npm:hud:test', 'npm:build:web', 'assets', 'native-tests', 'multiplayer', 'multiplayer-dry-deploy']);
  console.log('PROJECT_COMMANDS'); for (const item of value.commands.filter((entry) => contextCommands.has(entry.name))) console.log(`${item.name}=${item.command}`);
  console.log('DISTRIBUTION'); printObject({ channel: project.identity.channel, remote_commit: update.remoteCommit || 'unknown', status: update.status });
  if (previous) { console.log('LAST_RUN'); printObject({ objective: previous.objective || previous.command, result: previous.status.toUpperCase() }); }
  console.log(`FRONTIER=${value.frontier}`);
}

function renderContinue(value) {
  console.log('STATUS=PASS');
  printObject({ project: value.project.id, root: value.project.root, branch: value.project.branch });
  console.log('CURRENT');
  printObject({ head: value.currency.head, worktree: value.currency.worktreeFingerprint, dirty: value.currency.dirty });
  const objective = value.workingState.objective;
  const frontier = value.workingState.frontier;
  console.log(`OBJECTIVE=${objective?.value || 'none'}`);
  if (objective) console.log(`OBJECTIVE_CURRENCY=${objective.evidence}`);
  console.log(`FRONTIER=${frontier?.value || 'none'}`);
  if (frontier) console.log(`FRONTIER_CURRENCY=${frontier.evidence}`);
  if (value.lastMeaningfulRun) {
    console.log('LAST_MEANINGFUL_RUN');
    printObject(value.lastMeaningfulRun);
  }
  if (value.lastFailure) {
    console.log('LAST_FAILURE');
    printObject(value.lastFailure);
  }
  console.log('RECENT_EVIDENCE');
  for (const item of value.recentEvidence) console.log(`${item.status} ${item.command} ${item.evidence}`);
  printObject({ current_evidence: value.counts.current, stale_evidence: value.counts.stale, unknown_evidence: value.counts.unknown });
}

async function main() {
  const { command, args, options } = parse(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(command)) {
    console.log(HELP);
    return;
  }
  if (command === 'runtime') {
    let selectedProject = null;
    try { selectedProject = await resolveProject({ root: options.root }); }
    catch (error) { if (options.root) throw error; }
    const value = inspectRuntimeAuthority({
      executingPath: fileURLToPath(import.meta.url), project: selectedProject,
    });
    process.exitCode = value.status === 'CURRENT' ? 0 : value.status === 'UNKNOWN' ? 2 : 1;
    if (options.json) return console.log(JSON.stringify(value, null, 2));
    console.log(`COMMANDHUD_RUNTIME ${value.status}`);
    printObject({ executing: value.executing.path, executing_role: value.executing.role, source: value.source?.cli.path || 'unknown', same_bytes: value.sameBytes ?? 'unknown' });
    if (value.sourceCandidates.length > 1) {
      console.log('SOURCE_CANDIDATES');
      for (const candidate of value.sourceCandidates) console.log(candidate.cli.path);
    }
    if (value.projectCopies.length) {
      console.log('PROJECT_COPIES');
      for (const copy of value.projectCopies) console.log(copy.identity.path);
    }
    return;
  }
  const project = await resolveProject({ root: options.root });
  if (command === 'context' || command === 'status') return context(project, options.json);
  if (command === 'state') {
    const value = await currentState(project);
    if (options.json) return console.log(JSON.stringify(value, null, 2));
    printObject({
      project: value.project.name,
      cwd: value.cwd.display,
      branch: value.git.branch,
      head: value.git.head.slice(0, 7),
      dirty: value.git.dirty ? `${value.git.changedFiles.length} file${value.git.changedFiles.length === 1 ? '' : 's'}` : 'clean',
      workflow: value.workflow ? `${value.workflow.name} ${value.workflow.currentStage ?? 0}/${value.workflow.stageCount ?? '?'} ${value.workflow.status.toUpperCase()}` : 'none',
      last: value.last ? `${value.last.stage || 'command'} ${value.last.status.toUpperCase()} ${(value.last.durationMs / 1000).toFixed(1)}s` : 'none',
      next: value.next ?? 'none',
      status: value.status.toUpperCase(),
    });
    return;
  }
  if (command === 'tree') {
    const value = await repositoryTree(project.root);
    if (options.json) return console.log(JSON.stringify(value, null, 2));
    printObject({ root: value.root.name, directories: value.directoryCount, files: value.fileCount });
    for (const directory of value.root.directories) {
      console.log(`${directory.path} ${directory.directories.length}d ${directory.files.length}f`);
    }
    return;
  }
  if (command === 'file-identity') {
    if (!args[0]) throw new Error('hud file-identity requires a filesystem path.');
    const value = filesystemIdentity(args[0], { base: project.root });
    if (options.json) return console.log(JSON.stringify(value, null, 2));
    printObject(value);
    return;
  }
  if (command === 'compare-files') {
    if (!args[0] || !args[1]) throw new Error('hud compare-files requires two filesystem paths.');
    const record = await recordFilesystemComparison(project, args[0], args[1], { origin: 'cli-argv' });
    const value = record.operation.comparison;
    if (options.json) return console.log(JSON.stringify({ runId: record.id, status: record.status, operation: record.operation, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath }, null, 2));
    printObject({ status: value?.status || record.status, same_bytes: value?.sameBytes ?? 'unknown' });
    if (value) { console.log('LEFT'); printObject(value.left); console.log('RIGHT'); printObject(value.right); }
    console.log(`RAW run:${record.id}`);
    process.exitCode = record.status === 'pass' ? 0 : record.status === 'blocked' ? 2 : 1;
    return;
  }
  if (command === 'service') {
    if (!args[0]) throw new Error('hud service requires a Windows service name.');
    const record = await observeWindowsService(project, args[0], { origin: 'cli-argv' });
    if (options.json) return console.log(JSON.stringify({ runId: record.id, status: record.status, operation: record.operation, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath }, null, 2));
    const value = record.operation;
    console.log(`SERVICE ${value.name}`);
    console.log(`STATUS ${value.status.toUpperCase()} exit=${value.exitCode}`);
    if (value.observation) printObject({
      state: value.observation.status, display_name: value.observation.displayName,
      start_type: value.observation.startType, can_stop: value.observation.canStop,
      process_id: value.observation.processId, depends_on: value.observation.dependsOn,
      dependents: value.observation.dependents,
    });
    console.log(`RAW run:${record.id}`);
    process.exitCode = record.status === 'pass' ? 0 : record.status === 'blocked' ? 2 : 1;
    return;
  }
  if (command === 'service-reset-plan') {
    if (!args[0]) throw new Error('hud service-reset-plan requires a Windows service name.');
    const record = await planWindowsServiceReset(project, args[0], { origin: 'cli-argv' });
    if (options.json) return console.log(JSON.stringify({ runId: record.id, status: record.status, operation: record.operation, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath }, null, 2));
    const value = record.operation;
    console.log(`SERVICE_RESET_PLAN ${value.name}`);
    console.log(`STATUS ${value.status.toUpperCase()} exit=${value.exitCode}`);
    if (value.plan) printObject({ safe: value.plan.safe, blockers: value.plan.blockers, missing: value.plan.missing, stop_order: value.plan.stop, start_order: value.plan.start });
    console.log('ACTION=PLAN_ONLY');
    console.log(`RAW run:${record.id}`);
    process.exitCode = record.status === 'pass' ? 0 : record.status === 'blocked' ? 2 : 1;
    return;
  }
  if (command === 'desktop') {
    if (process.platform !== 'win32') throw new Error('The current CommandHUD desktop host is Windows-only. Use hud serve on this platform.');
    const { startDesktopHud } = await import('./desktop.mjs');
    const desktop = await startDesktopHud(project);
    console.log(`COMMANDHUD_DESKTOP=${desktop.url}`);
    console.log(`ROOT=${project.root}`);
    console.log(`HOST=${desktop.browser}`);
    if (desktop.recovery.recovered.length) console.log(`RECOVERED_INTERRUPTED=${desktop.recovery.recovered.join(',')}`);
    const stop = () => void desktop.close({ terminateBrowser: true });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try { await desktop.wait(); }
    finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  if (command === 'shell') {
    const { startHudShell } = await import('./shell.mjs');
    await startHudShell(project, { shell: options.shell || undefined, visual: options.animation, tui: options.tui });
    return;
  }
  if (command === 'serve') {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('hud serve requires a valid --port.');
    const { startHudServer } = await import('./server.mjs');
    const running = await startHudServer(project, { host: options.host, port: options.port });
    console.log(`HUD_URL=http://${running.host}:${running.port}/`);
    console.log(`ROOT=${project.root}`);
    console.log('MODE=TYPED_OPERATIONS');
    if (running.recovery.recovered.length) console.log(`RECOVERED_INTERRUPTED=${running.recovery.recovered.join(',')}`);
    return;
  }
  if (command === 'search') {
    const query = args[0];
    const scope = args[1] || '.';
    const record = await searchRepository(project, query, scope, { origin: 'cli-argv' });
    if (options.json) {
      console.log(JSON.stringify({
        runId: record.id, status: record.status, operation: record.operation,
        stdoutPath: record.stdoutPath, stderrPath: record.stderrPath,
        currency: record.currencyAfter,
      }, null, 2));
    } else {
      const result = record.operation;
      console.log(`SEARCH ${result.query}`);
      console.log(`SCOPE ${result.scope}`);
      console.log(`TOOL ${result.tool}${result.toolAvailable ? '' : ' unavailable'}`);
      console.log(`COMMAND ${result.command}`);
      console.log(`MATCHES ${result.matchCount}`);
      console.log(`FILES ${result.fileCount}`);
      for (const file of result.files) console.log(`${file.path} ${file.count} lines=${file.lines.join(',')}`);
      console.log(`RAW run:${record.id}`);
    }
    process.exitCode = record.status === 'pass' ? 0 : record.status === 'blocked' ? 2 : 1;
    return;
  }
  if (command === 'repository-command') {
    const name = args[0];
    if (!name) throw new Error('hud repository-command requires a discovered command name.');
    const record = await runRepositoryCommand(project, name, { stream: !options.quiet, origin: 'cli-argv' });
    if (options.json) {
      console.log(JSON.stringify({
        runId: record.id, status: record.status, operation: record.operation,
        presentation: record.presentation,
        stdoutPath: record.stdoutPath, stderrPath: record.stderrPath,
        currency: record.currencyAfter,
      }, null, 2));
    } else {
      const result = record.operation;
      console.log(`REPOSITORY_COMMAND ${result.name}`);
      console.log(`COMMAND ${result.command}`);
      console.log(`STATUS ${result.status.toUpperCase()}`);
      console.log(`DURATION ${result.durationMs}ms`);
      if (result.summary.length) console.log(`SUMMARY ${result.summary.join('; ')}`);
      console.log(`RAW run:${record.id}`);
    }
    process.exitCode = record.status === 'pass' ? 0 : record.status === 'blocked' ? 2 : 1;
    return;
  }
  if (command === 'undo-plan') {
    const runId = args[0];
    if (!runId) throw new Error('hud undo-plan requires a recorded run ID.');
    const plan = await undoPlan(project, runId);
    if (options.json) return console.log(JSON.stringify(plan, null, 2));
    printObject({ run: plan.runId, state: plan.state, files: plan.fileCount, reason: plan.reason });
    for (const path of plan.paths) console.log(path);
    return;
  }
  if (command === 'undo') {
    const runId = args[0];
    if (!runId) throw new Error('hud undo requires a recorded run ID.');
    const record = await undoOperation(project, runId, { stream: !options.quiet, origin: 'cli-argv' });
    if (options.json) return console.log(JSON.stringify({
      runId: record.id, status: record.status, operation: record.operation,
      stdoutPath: record.stdoutPath, stderrPath: record.stderrPath, currency: record.currencyAfter,
    }, null, 2));
    console.log(`UNDO ${record.operation.targetRunId}`);
    console.log(`STATUS ${record.status.toUpperCase()}`);
    console.log(`FILES ${record.operation.fileCount}`);
    for (const path of record.operation.paths) console.log(path);
    console.log(`RAW run:${record.id}`);
    return;
  }
  if (command === 'handoff') {
    const record = lastRun(project);
    if (!record) throw new Error('No recorded run exists for this project.');
    const context = await buildCurrentOperationContext(project, record);
    if (options.json) return console.log(JSON.stringify({ runId: record.id, ...context }, null, 2));
    const handoff = context.handoff;
    console.log(handoff);
    if (options.copy) copy(handoff);
    return;
  }
  if (command === 'continue') {
    const value = await continuation(project);
    return options.json ? console.log(JSON.stringify(value, null, 2)) : renderContinue(value);
  }
  if (command === 'objective' || command === 'frontier') {
    if (args[0] === '--clear') setWorkingValue(project, command, null, await repositoryCurrency(project.root, project.identity.id));
    else if (args.length) setWorkingValue(project, command, args.join(' '), await repositoryCurrency(project.root, project.identity.id));
    const value = workingValue(project, command);
    return options.json ? console.log(JSON.stringify(value, null, 2)) : console.log(`${command.toUpperCase()}=${value?.value || 'none'}`);
  }
  if (command === 'tools') {
    const value = { tools: await discoverTools(), commands: discoverCommands(project.root) };
    return options.json ? console.log(JSON.stringify(value, null, 2)) : (console.log('TOOLS'), printObject(value.tools), console.log('PROJECT_COMMANDS'), value.commands.forEach((item) => console.log(`${item.name}=${item.command}`)));
  }
  if (command === 'run') {
    const request = options.requestB64
      ? Buffer.from(options.requestB64, 'base64').toString('utf16le')
      : options.request;
    const workflow = options.workflowId ? {
      id: options.workflowId,
      name: options.workflowName,
      stage: options.stage,
      index: Number.isInteger(options.stageIndex) ? options.stageIndex : null,
      count: Number.isInteger(options.stageCount) ? options.stageCount : null,
    } : null;
    const record = await runCommand(project, args, { objective: options.objective, request, workflow, stream: !options.quiet, origin: 'cli-argv' });
    const packet = formatPacket(record.packet);
    const view = record.presentation;
    console.log(`\n${view.status.toUpperCase()} - ${(view.durationMs / 1000).toFixed(1)}s`);
    console.log(view.request);
    if (view.headline) console.log(view.headline);
    for (const line of view.details) console.log(line);
    console.log('packet ready');
    console.log(packet);
    if (options.copy) copy(packet);
    process.exitCode = record.exitCode === 0 ? 0 : record.status === 'blocked' ? 2 : 1;
    return;
  }
  if (command === 'last' || command === 'packet') {
    const record = lastRun(project);
    if (!record) throw new Error('No recorded run exists for this project.');
    if (command === 'last' && options.json) console.log(JSON.stringify(record, null, 2));
    else if (command === 'last') printObject({ id: record.id, status: record.status, command: record.command, exit_code: record.exitCode, stdout: record.stdoutPath, stderr: record.stderrPath });
    else { const packet = formatPacket(record.packet); console.log(packet); if (options.copy) copy(packet); }
    return;
  }
  if (command === 'workflow') {
    const id = args[0];
    if (!id) throw new Error('hud workflow requires a workflow id.');
    const value = workflowView(project, id);
    if (!value) throw new Error(`No workflow records found for ${id}.`);
    if (options.json) return console.log(JSON.stringify(value, null, 2));
    const packet = buildWorkflowPacket(value);
    console.log(packet);
    if (options.copy) copy(packet);
    return;
  }
  if (command === 'history') {
    const runs = listRuns(project, Number(args[0]) || 10);
    if (options.json) return console.log(JSON.stringify(runs, null, 2));
    for (const run of runs) console.log(`${run.id} ${run.status.toUpperCase()} exit=${run.exitCode} ${run.command}`);
    return;
  }
  if (['raw', 'head', 'tail', 'find', 'around'].includes(command)) {
    const runId = args[0];
    if (!runId) throw new Error(`hud ${command} requires a recorded run ID.`);
    const projection = projectRunEvidence(project, runId, command === 'find'
      ? { mode: command, pattern: args.slice(1).join(' ') }
      : command === 'around'
        ? { mode: command, pattern: args[1], context: args[2] }
        : { mode: command, count: args[1] });
    return options.json ? console.log(JSON.stringify(projection, null, 2)) : printEvidenceProjection(projection);
  }
  if (command === 'diff') {
    if (!args[0] || !args[1]) throw new Error('hud diff requires two recorded run IDs.');
    const value = await diffRunEvidence(project, args[0], args[1]);
    if (options.json) return console.log(JSON.stringify(value, null, 2));
    console.log(`RUN_DIFF ${value.leftRunId} -> ${value.rightRunId}`);
    console.log(`DIFFERENT ${value.different}`);
    for (const stream of value.streams) {
      console.log(`\n${stream.stream.toUpperCase()}${stream.different ? ' CHANGED' : ' UNCHANGED'}`);
      if (stream.text) console.log(stream.text);
      if (stream.truncated) console.log('[bounded: complete evidence remains in both runs]');
    }
    return;
  }
  if (command === 'copy') {
    const runId = args[0];
    if (!runId) throw new Error('hud copy requires a recorded run ID.');
    const record = runById(project, runId);
    if (!record) throw new Error(`No recorded run found for ${runId}.`);
    const value = await buildCurrentOperationContext(project, record);
    if (options.json) return console.log(JSON.stringify({ runId: record.id, ...value }, null, 2));
    console.log(value.handoff);
    copy(value.handoff);
    return;
  }
  if (command === 'update') {
    const update = await fetchUpdate(project);
    return options.json ? console.log(JSON.stringify(update, null, 2)) : printObject(update);
  }
  if (command === 'open') {
    const record = lastRun(project);
    if (!record) throw new Error('No recorded run exists for this project.');
    const target = args[0] === 'stderr' ? record.stderrPath : args[0] === 'record' ? record.stdoutPath.replace(/stdout\.log$/, 'run.json') : record.stdoutPath;
    console.log(readFileSync(target, 'utf8'));
    return;
  }
  throw new Error(`Unknown hud command: ${command}`);
}

main().catch((error) => {
  const blocked = /No Git repository|not the verified|No recorded run|Manifest request failed|unusable commit provenance|Clipboard tool is unavailable|hud service(?:-reset-plan)? requires|Windows service observation is available only/i.test(error.message);
  console.error(`${blocked ? 'CAUSE' : 'ERROR'}=${error.message}`);
  console.error(`STATUS=${blocked ? 'BLOCKED' : 'ERROR'}`);
  process.exitCode = blocked ? 2 : 3;
});
