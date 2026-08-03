'use strict';

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const {
  inspectProject,
  createOrder,
  agentPacket,
  run,
  defaultCloneDestination,
  isForbiddenImplicitProject,
  startProjectCommand,
  readHistoryRecords,
  latestHistoryOutput,
  historyTranscript,
  loadOrders,
  discoverFixture
} = require('./core');

const PROJECT_SELECTION_KEY = 'dataFactory.projectSelection';
let panel;
let livePanel;
let currentProject;
let currentOrder;
let currentExecution;

function rootPath() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

async function pickProjectFolder() {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'OPEN'
  });
  return picked?.[0]?.fsPath;
}

async function saveOrder(order) {
  const directory = path.join(order.authority.root, '.datafactory', 'orders');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${order.id}.json`), `${JSON.stringify(order, null, 2)}\n`, 'utf8');
}

function nonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function html(webview, extensionUri) {
  const token = nonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${token}';"><link rel="stylesheet" href="${css}"></head><body>
    <header><strong id="projectName">DATAFACTORY</strong><span id="face">(•‿•)</span><span id="signal">READY</span></header>
    <nav><button data-view="project" class="active">PROJECT</button><button data-view="work">WORK</button><button data-view="inspect">INSPECT</button><button data-view="chat">CHAT</button></nav>
    <main>
      <section id="project" class="view active"><div id="projectCard" class="card"></div></section>
      <section id="work" class="view"><div id="workCard" class="card empty">NO ORDER</div></section>
      <section id="inspect" class="view"><div class="card output-card"><div class="section-title">OUTPUT</div><pre id="inspectText">NO OUTPUT</pre></div></section>
      <section id="chat" class="view"><div id="chatCard" class="card"></div></section>
    </main>
    <section id="inputArea"><div class="section-title">INPUT</div><textarea id="intent" spellcheck="true" placeholder="Type a command or intention."></textarea><div class="actions"><button data-action="run" class="primary">RUN</button><button data-action="stop">STOP</button><button data-action="live">LIVE</button><button data-action="copy">COPY</button><button data-action="all">ALL</button><button data-action="goal">GOAL</button><button data-action="packet">PACKET</button></div></section>
    <footer><span id="root">NO PROJECT</span><span id="activity"></span></footer>
    <script nonce="${token}" src="${js}"></script></body></html>`;
}

function liveHtml(webview) {
  const token = nonce();
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}';"><style>body{margin:0;background:#0b1114;color:#e8f5f8;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word}</style></head><body><pre id="live">NO OUTPUT</pre><script nonce="${token}">window.addEventListener('message',({data})=>{document.getElementById('live').textContent=data.text||'NO OUTPUT';});</script></body></html>`;
}

function basename(target) {
  return target ? path.basename(target) : 'NO PROJECT';
}

function expectedProject(context) {
  return panel?._expectedProject
    || context.workspaceState.get('dataFactory.project')
    || context.globalState.get(PROJECT_SELECTION_KEY)
    || null;
}

async function rememberProject(context, project) {
  const selection = { root: project.root, origin: project.origin };
  panel._expectedProject = selection;
  await context.workspaceState.update('dataFactory.project', selection);
  await context.globalState.update(PROJECT_SELECTION_KEY, selection);
}

async function fixtureState() {
  try {
    return await discoverFixture(path.join(__dirname, '..', '..', '..', 'examples', 'digital-breakdown.project.json'));
  } catch {
    return null;
  }
}

function summarizeInspect(latest, running) {
  if (running) {
    return [`COMMAND    ${running.command}`, 'STATE      RUN', '', running.output || '(running)'].join('\n');
  }
  if (!latest) return 'NO OUTPUT';
  return [
    `COMMAND    ${latest.command}`,
    `EXIT       ${latest.exitCode === null ? latest.classification : latest.exitCode}`,
    `DURATION   ${(latest.durationMs / 1000).toFixed(3)}s`,
    `STATUS     ${String(latest.status || '').toUpperCase()}`,
    `LOG        ${latest.logPath}`,
    '',
    latest.output || '(no output)'
  ].join('\n');
}

async function sendLiveText(text) {
  if (!livePanel) return;
  livePanel.webview.postMessage({ text: text || 'NO OUTPUT' });
}

async function sendState(context) {
  if (!panel) return;
  const root = rootPath();
  const expected = expectedProject(context) || {};
  currentProject = await inspectProject(root, {
    expectedRoot: expected.root,
    expectedOrigin: expected.origin
  });

  if (currentProject.repository && currentProject.verified) {
    await rememberProject(context, currentProject);
  }

  const [orders, history, fixture] = currentProject.repository && currentProject.verified
    ? await Promise.all([
      loadOrders(currentProject.root),
      readHistoryRecords(currentProject.root),
      fixtureState()
    ])
    : [[], [], null];

  if ((!currentOrder || currentOrder.authority.root !== currentProject.root) && orders.length) {
    currentOrder = orders[orders.length - 1];
  }

  const latest = history.length ? history[history.length - 1] : null;
  const running = currentExecution
    ? {
        command: currentExecution.command,
        output: currentExecution.getOutput().trimEnd(),
        startedAt: currentExecution.startedAt,
        logPath: currentExecution.logPath
      }
    : null;

  panel.webview.postMessage({
    type: 'state',
    project: currentProject,
    order: currentOrder || null,
    orders,
    latest,
    running,
    fixture,
    inspect: summarizeInspect(latest, running)
  });
  await sendLiveText(running?.output || latest?.output || 'NO OUTPUT');
}

async function ensureVerifiedProject(context) {
  const project = await inspectProject(rootPath(), expectedProject(context) || {});
  if (!project.repository || !project.verified) {
    throw new Error(project.state || 'NO PROJECT');
  }
  currentProject = project;
  await rememberProject(context, project);
  return project;
}

async function ensureLivePanel(context) {
  if (livePanel) {
    livePanel.reveal(vscode.ViewColumn.Beside);
    return livePanel;
  }
  livePanel = vscode.window.createWebviewPanel('dataFactoryLive', 'DataFactory Live', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true
  });
  livePanel.webview.html = liveHtml(livePanel.webview, context.extensionUri);
  livePanel.onDidDispose(() => { livePanel = undefined; });
  return livePanel;
}

async function openVerifiedRoot(context, candidate, expectedOrigin = '') {
  const project = await inspectProject(candidate, { expectedOrigin });
  if (!project.repository || !project.verified) {
    throw new Error(project.state || 'PROJECT NOT VERIFIED');
  }
  await rememberProject(context, project);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.root), false);
}

async function handleClone(context) {
  const repository = await vscode.window.showInputBox({
    prompt: 'Repository URL',
    placeHolder: 'https://github.com/owner/repo.git',
    value: 'https://github.com/indrolend/hate.this.meaningless.life.git',
    ignoreFocusOut: true
  });
  if (!repository) return;

  const suggestion = defaultCloneDestination(undefined, repository);
  const destination = await vscode.window.showInputBox({
    prompt: 'Clone destination',
    value: suggestion,
    ignoreFocusOut: true
  });
  if (!destination) return;
  if (isForbiddenImplicitProject(destination)) throw new Error('NO PROJECT');

  try {
    await fs.access(destination);
    const existing = await inspectProject(destination, { expectedOrigin: repository });
    if (existing.repository && existing.verified) {
      await rememberProject(context, existing);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(existing.root), false);
      return;
    }
    throw new Error('DESTINATION EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const cloned = await run('git', ['clone', repository, destination], path.dirname(destination));
  if (!cloned.ok) throw new Error(cloned.stderr || cloned.error?.message || 'CLONE FAILED');
  await openVerifiedRoot(context, destination, repository);
}

async function handleRun(context, command) {
  if (currentExecution) throw new Error('RUNNING');
  const project = await ensureVerifiedProject(context);
  currentExecution = await startProjectCommand(command, project);
  currentExecution.onOutput(async () => {
    panel?.webview.postMessage({ type: 'running', command: currentExecution.command, output: currentExecution.getOutput() });
    await sendLiveText(currentExecution.getOutput());
  });
  currentExecution.done.then(async (result) => {
    currentExecution = undefined;
    panel?.webview.postMessage({ type: 'result', ok: result.ok, text: summarizeInspect(result), result });
    await sendState(context);
  }).catch(async (error) => {
    currentExecution = undefined;
    panel?.webview.postMessage({ type: 'error', text: error.message });
    await sendState(context);
  });
  await sendState(context);
}

async function copyLatest(context) {
  const project = await ensureVerifiedProject(context);
  if (currentExecution) {
    await vscode.env.clipboard.writeText(currentExecution.getOutput().trimEnd());
    panel?.webview.postMessage({ type: 'copied' });
    return;
  }
  const history = await readHistoryRecords(project.root);
  await vscode.env.clipboard.writeText(latestHistoryOutput(history));
  panel?.webview.postMessage({ type: 'copied' });
}

async function copyAll(context) {
  const project = await ensureVerifiedProject(context);
  const history = await readHistoryRecords(project.root);
  let transcript = historyTranscript(history);
  if (currentExecution) {
    transcript = [
      transcript,
      transcript ? '' : null,
      `$ ${currentExecution.command}`,
      currentExecution.getOutput().trimEnd()
    ].filter((value) => value !== null && value !== undefined && value !== '').join('\n\n');
  }
  await vscode.env.clipboard.writeText(transcript);
  panel?.webview.postMessage({ type: 'copiedAll' });
}

async function open(context) {
  if (panel) {
    panel.reveal();
    return sendState(context);
  }

  panel = vscode.window.createWebviewPanel('dataFactory', 'DataFactory', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
  });
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.onDidDispose(() => { panel = undefined; });
  panel._expectedProject = expectedProject(context);
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.action === 'open') {
        const nextRoot = await pickProjectFolder();
        if (!nextRoot) return;
        await openVerifiedRoot(context, nextRoot);
        return;
      }
      if (message.action === 'clone') {
        await handleClone(context);
        return;
      }
      if (message.action === 'refresh') {
        await sendState(context);
        return;
      }
      if (message.action === 'status') {
        await handleRun(context, 'git status --short --branch');
        return;
      }
      if (message.action === 'run') {
        if (!String(message.intent || '').trim()) return;
        await handleRun(context, message.intent);
        return;
      }
      if (message.action === 'stop') {
        currentExecution?.stop();
        return;
      }
      if (message.action === 'live') {
        await ensureLivePanel(context);
        await sendLiveText(currentExecution?.getOutput() || (await readHistoryRecords((await ensureVerifiedProject(context)).root)).slice(-1)[0]?.output || 'NO OUTPUT');
        return;
      }
      if (message.action === 'copy') {
        await copyLatest(context);
        return;
      }
      if (message.action === 'all') {
        await copyAll(context);
        return;
      }
      if (message.action === 'goal') {
        const project = await ensureVerifiedProject(context);
        currentOrder = createOrder(message.intent, project);
        await saveOrder(currentOrder);
        panel.webview.postMessage({ type: 'savedOrder' });
        await sendState(context);
        return;
      }
      if (message.action === 'packet') {
        if (!currentOrder) throw new Error('NO ORDER');
        await vscode.env.clipboard.writeText(agentPacket(currentOrder));
        panel.webview.postMessage({ type: 'packet' });
        return;
      }
      if (message.action === 'paste') {
        const text = await vscode.env.clipboard.readText();
        panel.webview.postMessage({ type: 'paste', text });
      }
    } catch (error) {
      panel?.webview.postMessage({ type: 'error', text: error.message });
    }
  });
  await sendState(context);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('dataFactory.open', () => open(context)),
    vscode.commands.registerCommand('dataFactory.refresh', () => sendState(context)),
    vscode.commands.registerCommand('dataFactory.goal', () => open(context)),
    vscode.commands.registerCommand('dataFactory.status', async () => {
      await open(context);
      await handleRun(context, 'git status --short --branch');
    })
  );

  if (vscode.workspace.getConfiguration('dataFactory').get('openOnStartup')) open(context);
}

module.exports = { activate, deactivate() {} };
