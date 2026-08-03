const vscode = acquireVsCodeApi();
const views = [...document.querySelectorAll('.view')];
const tabs = [...document.querySelectorAll('nav button')];
const signal = document.querySelector('#signal');
const face = document.querySelector('#face');
const activity = document.querySelector('#activity');
const intent = document.querySelector('#intent');
const inspectText = document.querySelector('#inspectText');

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

function makeButton(label, action) {
  const button = document.createElement('button');
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function appendDetailList(target, rows) {
  const list = document.createElement('dl');
  for (const [name, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  target.append(list);
}

function renderProject(project, fixture) {
  const root = project.root || 'NO PROJECT';
  const name = project.repository ? root.split(/[\\/]/).filter(Boolean).pop() : 'NO PROJECT';
  document.querySelector('#projectName').textContent = name;
  document.querySelector('#root').textContent = root;

  const card = document.querySelector('#projectCard');
  card.replaceChildren();

  const title = document.createElement('h1');
  title.textContent = name;
  card.append(title);

  appendDetailList(card, [
    ['STATE', project.state || 'NO PROJECT'],
    ['ROOT', root],
    ['ORIGIN', project.origin || '—'],
    ['BRANCH', project.branch || '—'],
    ['COMMIT', project.head ? project.head.slice(0, 12) : '—'],
    ['DIRTY', String(project.changes?.length || 0)],
    ['CAPS', fixture ? `${fixture.state}${fixture.discovered?.length ? ` · ${fixture.discovered.join(', ')}` : ''}` : 'unknown']
  ]);

  const actions = document.createElement('div');
  actions.className = 'inline-actions';
  actions.append(
    makeButton('OPEN', 'open'),
    makeButton('CLONE', 'clone'),
    makeButton('REFRESH', 'refresh'),
    makeButton('STATUS', 'status')
  );
  card.append(actions);
}

function renderWork(order, orders) {
  const card = document.querySelector('#workCard');
  card.replaceChildren();

  if (!order) {
    card.className = 'card empty';
    card.textContent = 'NO ORDER';
    return;
  }

  card.className = 'card';
  const title = document.createElement('h1');
  title.textContent = order.intent;
  card.append(title);

  appendDetailList(card, [
    ['STATUS', String(order.status || 'ready').toUpperCase()],
    ['BASE', order.authority.commit ? order.authority.commit.slice(0, 12) : '—'],
    ['FILES', String(order.authority.dirty?.length || 0)],
    ['ID', order.id]
  ]);

  const recent = document.createElement('div');
  recent.className = 'recent';
  const recentTitle = document.createElement('div');
  recentTitle.className = 'section-title small';
  recentTitle.textContent = 'RECENT';
  recent.append(recentTitle);

  const items = (orders || []).slice(-4).reverse();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'NO RECENT ORDERS';
    recent.append(empty);
  } else {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      const id = document.createElement('span');
      id.textContent = item.id;
      const summary = document.createElement('strong');
      summary.textContent = item.intent;
      row.append(id, summary);
      recent.append(row);
    }
  }

  card.append(recent);
}

function renderChat() {
  const card = document.querySelector('#chatCard');
  card.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'CHAT';
  const body = document.createElement('p');
  body.textContent = 'Type freely below. RUN executes under the verified root. GOAL records a bounded order. PACKET copies the current order for any provider.';
  card.append(title, body);
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
    inspectText.textContent = data.inspect || 'NO OUTPUT';
    setSignal(data.running ? 'RUN' : (data.project.state || (data.project.repository ? 'READY' : 'NO PROJECT')));
  }
  if (data.type === 'running') {
    inspectText.textContent = data.output || currentState?.inspect || 'NO OUTPUT';
    setSignal('RUN');
    show('inspect');
  }
  if (data.type === 'result') {
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
