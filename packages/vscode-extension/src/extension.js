'use strict';

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { inspectProject, createOrder, agentPacket, run } = require('./core');

let panel;
let currentProject;
let currentOrder;

function rootPath() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

async function saveOrder(order) {
  const root = rootPath();
  const directory = path.join(root, '.datafactory', 'orders');
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
    <header><strong>DATAFACTORY</strong><span id="face">(•‿•)</span><span id="signal">READY</span></header>
    <nav><button data-view="project" class="active">PROJECT</button><button data-view="work">WORK</button><button data-view="inspect">INSPECT</button><button data-view="chat">CHAT</button></nav>
    <main>
      <section id="project" class="view active"><div id="projectCard" class="card"></div><div class="actions"><button data-action="refresh">REFRESH</button><button data-action="status">STATUS</button></div></section>
      <section id="work" class="view"><div id="orderCard" class="card empty">NO ORDER</div><div class="actions"><button data-action="copy">COPY</button></div></section>
      <section id="inspect" class="view"><pre id="inspectText">Select an order.</pre></section>
      <section id="chat" class="view"><textarea id="intent" spellcheck="true" placeholder="What should happen?"></textarea><div class="actions"><button data-action="goal" class="primary">GOAL</button></div></section>
    </main>
    <footer><span id="root">NO PROJECT</span><span id="activity"></span></footer>
    <script nonce="${token}" src="${js}"></script></body></html>`;
}

async function sendState() {
  if (!panel || !rootPath()) return;
  currentProject = await inspectProject(rootPath());
  panel.webview.postMessage({ type: 'state', project: currentProject, order: currentOrder || null });
}

async function open(context) {
  if (!rootPath()) return vscode.window.showErrorMessage('Open a project folder first.');
  if (panel) { panel.reveal(); return sendState(); }
  panel = vscode.window.createWebviewPanel('dataFactory', 'DataFactory', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
  });
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.action === 'refresh') await sendState();
      if (message.action === 'status') {
        const result = await run('git', ['status', '--short', '--branch'], rootPath());
        panel.webview.postMessage({ type: 'result', ok: result.ok, text: result.stdout || result.stderr || 'clean' });
      }
      if (message.action === 'goal') {
        currentProject = await inspectProject(rootPath());
        currentOrder = createOrder(message.intent, currentProject);
        await saveOrder(currentOrder);
        panel.webview.postMessage({ type: 'state', project: currentProject, order: currentOrder });
      }
      if (message.action === 'copy' && currentOrder) {
        await vscode.env.clipboard.writeText(agentPacket(currentOrder));
        panel.webview.postMessage({ type: 'copied' });
      }
    } catch (error) {
      panel.webview.postMessage({ type: 'error', text: error.message });
    }
  });
  await sendState();
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('dataFactory.open', () => open(context)),
    vscode.commands.registerCommand('dataFactory.refresh', sendState),
    vscode.commands.registerCommand('dataFactory.goal', () => open(context)),
    vscode.commands.registerCommand('dataFactory.status', async () => {
      await open(context);
      const result = await run('git', ['status', '--short', '--branch'], rootPath());
      panel?.webview.postMessage({ type: 'result', ok: result.ok, text: result.stdout || result.stderr || 'clean' });
    })
  );
  if (vscode.workspace.getConfiguration('dataFactory').get('openOnStartup')) open(context);
}

module.exports = { activate, deactivate() {} };
