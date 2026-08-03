const vscode = acquireVsCodeApi();
const views = [...document.querySelectorAll('.view')];
const tabs = [...document.querySelectorAll('nav button')];
const signal = document.querySelector('#signal');
const face = document.querySelector('#face');
const activity = document.querySelector('#activity');
const intent = document.querySelector('#intent');
let packet = '';

function fillDetails(card, rows) {
  const list = document.createElement('dl');
  rows.forEach(([name, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  });
  card.append(list);
}

function show(name) {
  views.forEach((view) => view.classList.toggle('active', view.id === name));
  tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  if (name === 'chat') intent.focus();
}

function flash(text, kind = 'ok') {
  activity.textContent = text;
  activity.dataset.kind = kind;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { activity.textContent = ''; }, 1300);
}

tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.view)));
document.addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  if (action === 'goal') vscode.postMessage({ action, intent: intent.value });
  else vscode.postMessage({ action });
});
intent.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    vscode.postMessage({ action: 'goal', intent: intent.value });
  }
});

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    const p = data.project;
    signal.textContent = p.state || (p.repository ? 'READY' : 'NO PROJECT');
    face.textContent = signal.textContent === 'FAIL' ? '(×_×)' : '(•‿•)';
    document.querySelector('#root').textContent = p.root || 'NO PROJECT';
    const projectCard = document.querySelector('#projectCard');
    projectCard.replaceChildren();
    const branchTitle = document.createElement('h1');
    branchTitle.textContent = p.repository ? p.branch : 'NOT GIT';
    projectCard.append(branchTitle);
    fillDetails(projectCard, [
      ['STATE', p.state || 'NO PROJECT'],
      ['COMMIT', p.head ? p.head.slice(0, 12) : '—'],
      ['CHANGES', String(p.changes.length)],
      ['PATH', p.root || 'NO PROJECT']
    ]);
    const card = document.querySelector('#orderCard');
    if (data.order) {
      const o = data.order;
      packet = JSON.stringify(o, null, 2);
      card.className = 'card';
      card.replaceChildren();
      const id = document.createElement('small');
      id.textContent = o.id;
      const orderIntent = document.createElement('h1');
      orderIntent.textContent = o.intent;
      const status = document.createElement('p');
      status.textContent = o.status.toUpperCase();
      card.append(id, orderIntent, status);
      document.querySelector('#inspectText').textContent = packet;
      intent.value = '';
      show('work');
      flash('SAVED'); face.textContent = '(•‿•)'; signal.textContent = 'READY';
    }
  }
  if (data.type === 'result') {
    document.querySelector('#inspectText').textContent = data.text;
    signal.textContent = data.ok ? 'PASS' : 'FAIL';
    face.textContent = data.ok ? '(•‿•)' : '(×_×)';
    show('inspect');
  }
  if (data.type === 'copied') flash('COPIED');
  if (data.type === 'error') { flash(data.text, 'error'); signal.textContent = 'STOP'; face.textContent = '(._.)'; }
});
