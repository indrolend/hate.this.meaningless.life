#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { formatPacket, resolveProject, gitSnapshot, discoverCommands, discoverTools, runCommand, lastRun, listRuns, fetchUpdate } from './core.mjs';

function parse(argv) {
  const args = [...argv];
  const options = { copy: false, quiet: false, root: null, objective: null, json: false };
  const command = args.shift() || 'context';
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') { positionals.push(...args.slice(index + 1)); break; }
    if (value === '--copy' || value === '--copy-packet') options.copy = true;
    else if (value === '--quiet') options.quiet = true;
    else if (value === '--json') options.json = true;
    else if (value === '--root' || value === '--objective') options[value.slice(2)] = args[++index];
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

async function main() {
  const { command, args, options } = parse(process.argv.slice(2));
  const project = await resolveProject({ root: options.root });
  if (command === 'context' || command === 'status') return context(project, options.json);
  if (command === 'tools') {
    const value = { tools: await discoverTools(), commands: discoverCommands(project.root) };
    return options.json ? console.log(JSON.stringify(value, null, 2)) : (console.log('TOOLS'), printObject(value.tools), console.log('PROJECT_COMMANDS'), value.commands.forEach((item) => console.log(`${item.name}=${item.command}`)));
  }
  if (command === 'run') {
    const record = await runCommand(project, args, { objective: options.objective, stream: !options.quiet });
    const packet = formatPacket(record.packet);
    console.log(`\n${record.status.toUpperCase()} ${record.command} ${(record.durationMs / 1000).toFixed(1)}s`);
    console.log(`HEAD ${record.headAfter.slice(0, 12)}`);
    console.log(`DIRTY ${record.dirtyAfter ? 'dirty' : 'clean'}`);
    for (const line of record.reduction.summary) console.log(line);
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
  if (command === 'history') {
    const runs = listRuns(project, Number(args[0]) || 10);
    if (options.json) return console.log(JSON.stringify(runs, null, 2));
    for (const run of runs) console.log(`${run.id} ${run.status.toUpperCase()} exit=${run.exitCode} ${run.command}`);
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
  const blocked = /No Git repository|not the verified|No recorded run|Manifest request failed|unusable commit provenance|Clipboard tool is unavailable/i.test(error.message);
  console.error(`${blocked ? 'CAUSE' : 'ERROR'}=${error.message}`);
  console.error(`STATUS=${blocked ? 'BLOCKED' : 'ERROR'}`);
  process.exitCode = blocked ? 2 : 3;
});
