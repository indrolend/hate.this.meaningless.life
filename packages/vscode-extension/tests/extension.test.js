'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const extensionPath = path.resolve(__dirname, '../src/extension.js');

async function loadHarness(overrides = {}) {
  const messages = [];
  const commandMap = new Map();
  const workspaceStateStore = new Map();
  const globalStateStore = new Map();
  const executeCalls = [];
  const openDialogValues = [...(overrides.openDialogValues || ['/picked'])];
  const inputValues = [...(overrides.inputValues || [])];

  const panel = {
    _messageHandler: null,
    _expectedProject: null,
    webview: {
      html: '',
      asWebviewUri(value) { return value; },
      onDidReceiveMessage(handler) { panel._messageHandler = handler; },
      postMessage(message) { messages.push(message); }
    },
    onDidDispose() {},
    reveal() {}
  };

  const vscode = {
    workspace: {
      workspaceFolders: overrides.workspaceFolders || [{ uri: { fsPath: '/workspace' } }],
      getConfiguration() { return { get() { return false; } }; }
    },
    window: {
      createWebviewPanel() { return panel; },
      async showOpenDialog() { return [{ fsPath: openDialogValues.shift() }]; },
      async showInputBox() { return inputValues.shift() ?? null; }
    },
    commands: {
      registerCommand(name, handler) {
        commandMap.set(name, handler);
        return { dispose() {} };
      },
      async executeCommand(...args) {
        executeCalls.push(args);
      }
    },
    env: {
      clipboard: {
        async writeText(value) { messages.push({ type: 'clipboard', value }); },
        async readText() { return overrides.clipboardText || ''; }
      }
    },
    Uri: {
      file(fsPath) { return { fsPath }; },
      joinPath(...parts) { return parts.join('/'); }
    },
    ViewColumn: { One: 1, Beside: 2 }
  };

  const fsPromises = overrides.fsPromises || {
    mkdir: async () => {},
    writeFile: async () => {},
    access: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    readFile: async () => '[]'
  };

  const core = Object.assign({
    inspectProject: async (target) => {
      if (target === '/picked') return { root: '/picked', origin: 'git@github.com:indrolend/example.git', repository: true, verified: true, state: 'READY', branch: 'main', head: 'abc123', changes: [] };
      if (target === '/existing') return { root: '/existing', origin: 'git@github.com:indrolend/example.git', repository: true, verified: true, state: 'READY', branch: 'main', head: 'abc123', changes: [] };
      return { root: target || '', origin: '', repository: false, verified: false, state: 'NO PROJECT', branch: '', head: '', changes: [] };
    },
    createOrder: (intent, project) => ({ id: 'order-1', intent, authority: { root: project.root, commit: project.head, dirty: project.changes || [] }, status: 'ready' }),
    agentPacket: () => 'packet',
    run: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    defaultCloneDestination: () => '/existing',
    isForbiddenImplicitProject: () => false,
    startProjectCommand: async () => ({ command: 'echo ok', getOutput: () => '', onOutput() {}, done: Promise.resolve({ ok: true, output: '', exitCode: 0, durationMs: 0, status: 'passed', logPath: '/tmp/log', command: 'echo ok' }) }),
    readHistoryRecords: async () => [],
    latestHistoryOutput: () => '',
    historyTranscript: () => '',
    loadOrders: async () => [],
    discoverFixture: async () => ({ state: 'AUTH', discovered: [] })
  }, overrides.core || {});

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'fs/promises') return fsPromises;
    if (request === './core' && parent && parent.filename === extensionPath) return core;
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[extensionPath];
  const extension = require(extensionPath);
  Module._load = originalLoad;

  const context = {
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
    workspaceState: {
      get(key) { return workspaceStateStore.get(key); },
      async update(key, value) { workspaceStateStore.set(key, value); }
    },
    globalState: {
      get(key) { return globalStateStore.get(key); },
      async update(key, value) { globalStateStore.set(key, value); }
    }
  };

  extension.activate(context);
  await commandMap.get('dataFactory.open')();

  return {
    panel,
    messages,
    executeCalls,
    workspaceStateStore,
    globalStateStore,
    commandMap,
    context
  };
}

test('selected project persists immediately after OPEN', async () => {
  const harness = await loadHarness();
  await harness.panel._messageHandler({ action: 'open' });
  assert.deepEqual(harness.globalStateStore.get('dataFactory.projectSelection'), {
    root: '/picked',
    origin: 'git@github.com:indrolend/example.git'
  });
  assert.deepEqual(harness.executeCalls.at(-1), ['vscode.openFolder', { fsPath: '/picked' }, false]);
});

test('existing clone destination is verified and never overwritten', async () => {
  let cloned = false;
  const harness = await loadHarness({
    inputValues: ['https://github.com/indrolend/example.git', '/existing'],
    fsPromises: {
      mkdir: async () => {},
      writeFile: async () => {},
      access: async () => {}
    },
    core: {
      run: async () => {
        cloned = true;
        return { ok: true, stdout: '', stderr: '', code: 0 };
      }
    }
  });
  await harness.panel._messageHandler({ action: 'clone' });
  assert.equal(cloned, false);
  assert.deepEqual(harness.globalStateStore.get('dataFactory.projectSelection'), {
    root: '/existing',
    origin: 'git@github.com:indrolend/example.git'
  });
  assert.deepEqual(harness.executeCalls.at(-1), ['vscode.openFolder', { fsPath: '/existing' }, false]);
});
