const vscode = acquireVsCodeApi();
const views = [...document.querySelectorAll('.view')];
const tabs = [...document.querySelectorAll('nav button')];
const signal = document.querySelector('#signal');
const face = document.querySelector('#face');
const activity = document.querySelector('#activity');
const intent = document.querySelector('#intent');
let packet = '';

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
    document.querySelector('#root').textContent = p.root;
    document.querySelector('#projectCard').innerHTML = `<h1>${p.repository ? p.branch : 'NOT GIT'}</h1><dl><dt>COMMIT</dt><dd>${p.head ? p.head.slice(0, 12) : '—'}</dd><dt>CHANGES</dt><dd>${p.changes.length}</dd><dt>PATH</dt><dd>${p.root}</dd></dl>`;
    const card = document.querySelector('#orderCard');
    if (data.order) {
      const o = data.order;
      packet = JSON.stringify(o, null, 2);
      card.className = 'card';
      card.innerHTML = `<small>${o.id}</small><h1>${o.intent.replace(/[<>&]/g, '')}</h1><p>${o.status.toUpperCase()}</p>`;
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
