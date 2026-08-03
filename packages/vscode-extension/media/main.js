const vscode = acquireVsCodeApi();
const views = [...document.querySelectorAll('.view')];
const tabs = [...document.querySelectorAll('nav button')];
const signal = document.querySelector('#signal');
const face = document.querySelector('#face');
const activity = document.querySelector('#activity');
const intent = document.querySelector('#intent');
const inspectText = document.querySelector('#inspectText');

let latestOutput = '';
let currentState = null;

function faceFor(state) {
  switch (state) {
    case 'RUN': return '(o_o)';
    case 'PASS':
    case 'READY': return '(•‿•)';
    case 'FAIL': return '(×_×)';
    case 'STOP': return '(-_-)';
    case 'STALE': return '(¬_¬)';
    case 'COPIED': return '(^‿^)';
    case 'DIRTY':
    case 'AUTH':
    case 'GIT MISSING': return '(._.)';
    default: return '(•‿•)';
  }
}

function show(name) {
  views.forEach((view) => view.classList.toggle('active', view.id === name));
  tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
}

function flash(text, kind = 'ok') {
  activity.textContent = text;
  activity.dataset.kind = kind;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { activity.textContent = ''; }, 1400);
}

function setSignal(next) {
  signal.textContent = next;
  face.textContent = faceFor(next);
}

function renderProject(project, fixture) {
  const root = project.root || 'NO PROJECT';
  const name = project.repository ? root.split(/[\\/]/).filter(Boolean).pop() : 'NO PROJECT';
  document.querySelector('#projectName').textContent = name;
  document.querySelector('#root').textContent = root;
  document.querySelector('#projectCard').innerHTML = `
    <h1>${name}</h1>
    <dl>
      <dt>STATE</dt><dd>${project.state || 'NO PROJECT'}</dd>
      <dt>ROOT</dt><dd>${root}</dd>
      <dt>ORIGIN</dt><dd>${project.origin || '—'}</dd>
      <dt>BRANCH</dt><dd>${project.branch || '—'}</dd>
      <dt>COMMIT</dt><dd>${project.head ? project.head.slice(0, 12) : '—'}</dd>
      <dt>DIRTY</dt><dd>${String(project.changes?.length || 0)}</dd>
      <dt>CAPS</dt><dd>${fixture ? `${fixture.state}${fixture.discovered?.length ? ` · ${fixture.discovered.join(', ')}` : ''}` : 'unknown'}</dd>
    </dl>
    <div class="inline-actions"><button data-action="open">OPEN</button><button data-action="clone">CLONE</button><button data-action="refresh">REFRESH</button><button data-action="status">STATUS</button></div>
  `;
}

function renderWork(order, orders) {
  const recent = (orders || []).slice(-4).reverse();
  if (!order) {
    document.querySelector('#workCard').className = 'card empty';
    document.querySelector('#workCard').innerHTML = 'NO ORDER';
    return;
  }
  document.querySelector('#workCard').className = 'card';
  document.querySelector('#workCard').innerHTML = `
    <h1>${order.intent}</h1>
    <dl>
      <dt>STATUS</dt><dd>${String(order.status || 'ready').toUpperCase()}</dd>
      <dt>BASE</dt><dd>${order.authority.commit ? order.authority.commit.slice(0, 12) : '—'}</dd>
      <dt>FILES</dt><dd>${String(order.authority.dirty?.length || 0)}</dd>
      <dt>ID</dt><dd>${order.id}</dd>
    </dl>
    <div class="recent">
      <div class="section-title small">RECENT</div>
      ${(recent.length ? recent.map((item) => `<div class="recent-row"><span>${item.id}</span><strong>${item.intent}</strong></div>`).join('') : '<div class="muted">NO RECENT ORDERS</div>')}
    </div>
  `;
}

function renderChat() {
  document.querySelector('#chatCard').innerHTML = `
    <h1>CHAT</h1>
    <p>Type freely below. RUN executes under the verified root. GOAL records a bounded order. PACKET copies the current order for any provider.</p>
  `;
}

tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.view)));
document.addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  if (action) {
    vscode.postMessage({ action, intent: intent.value });
    return;
  }
  if (event.target === inspectText) {
    vscode.postMessage({ action: 'copy' });
  }
});

intent.addEventListener('click', () => {
  if (!intent.value) vscode.postMessage({ action: 'paste' });
});

intent.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.shiftKey) return;
  event.preventDefault();
  vscode.postMessage({ action: 'run', intent: intent.value });
});

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    currentState = data;
    renderProject(data.project, data.fixture);
    renderWork(data.order, data.orders);
    renderChat();
    latestOutput = data.running?.output || data.latest?.output || '';
    inspectText.textContent = data.inspect || 'NO OUTPUT';
    setSignal(data.running ? 'RUN' : (data.project.state || (data.project.repository ? 'READY' : 'NO PROJECT')));
  }
  if (data.type === 'running') {
    latestOutput = data.output || latestOutput;
    inspectText.textContent = currentState?.inspect || inspectText.textContent;
    setSignal('RUN');
    show('inspect');
  }
  if (data.type === 'result') {
    latestOutput = data.result?.output || latestOutput;
    inspectText.textContent = data.text;
    setSignal(data.ok ? 'PASS' : (data.result?.classification === 'stopped' ? 'STOP' : 'FAIL'));
    if (data.ok) intent.value = '';
    show('inspect');
  }
  if (data.type === 'copied') {
    setSignal('COPIED');
    flash('COPIED');
  }
  if (data.type === 'copiedAll') {
    setSignal('COPIED');
    flash('ALL');
  }
  if (data.type === 'packet') {
    flash('PACKET');
  }
  if (data.type === 'savedOrder') {
    flash('SAVED');
    show('work');
  }
  if (data.type === 'paste' && data.text && !intent.value) {
    intent.value = data.text;
    intent.selectionStart = intent.value.length;
    intent.selectionEnd = intent.value.length;
  }
  if (data.type === 'error') {
    flash(data.text, 'error');
    setSignal(data.text === 'RUNNING' ? 'RUN' : 'STOP');
  }
});

renderChat();
