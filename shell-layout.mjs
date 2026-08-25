const CSI = '\x1b[';
const FOOTER_ACTIONS = [
  { label: '[ COPY OUTPUT ]', command: '/copy' },
  { label: '[ RAW ]', command: '/raw' },
  { label: '[ UNDO ]', command: '/undo' },
  { label: '[ HELP ]', command: '/help' },
  { label: '[ EXIT ]', command: '/exit' },
];

function footerText() {
  return `AUTO-COPY ON  ·  ${FOOTER_ACTIONS.map((item) => item.label).join(' ')}`;
}

export function footerActionAt(column, footer = footerText()) {
  for (const item of FOOTER_ACTIONS) {
    const start = footer.indexOf(item.label) + 1;
    if (start > 0 && column >= start && column < start + item.label.length) return item.command;
  }
  return null;
}

export function splitMouseInput(value) {
  const events = [];
  const text = String(value).replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, button, column, row, phase) => {
    events.push({ button: Number(button), column: Number(column), row: Number(row), phase });
    return '';
  });
  return { text, events };
}

function terminalSize(output) {
  return {
    columns: Math.max(40, Number(output.columns) || 80),
    rows: Math.max(16, Number(output.rows) || 24),
  };
}

function clip(text, width) {
  const value = String(text).replaceAll('\t', '  ');
  return value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
}

export function fitPanelLines(text, width, height) {
  const lines = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
    .map((line) => clip(line, width));
  if (lines.length <= height) return [...lines, ...Array(Math.max(0, height - lines.length)).fill('')];
  if (height < 3) return lines.slice(0, height);
  const head = Math.ceil((height - 1) * 0.7);
  const tail = height - head - 1;
  return [...lines.slice(0, head), `… ${lines.length - head - tail} lines hidden · /context or /raw`, ...lines.slice(-tail)];
}

export function createShellLayout(output, { enabled = true } = {}) {
  let active = false;
  let lastPanel = '';
  let hoveredAction = null;

  function writeAt(row, value) {
    output.write(`${CSI}${row};1H${CSI}2K${value}`);
  }

  function frame() {
    if (!active) return;
    const { columns, rows } = terminalSize(output);
    const rule = '─'.repeat(columns);
    writeAt(1, clip('(._.)  hate.this.meaningless.life  ·  context condenser', columns));
    writeAt(2, 'IDLE');
    writeAt(3, rule);
    writeAt(4, '> ');
    writeAt(5, rule);
    writeAt(rows - 3, rule);
    renderFooter(false);
    writeAt(rows - 1, '');
    writeAt(rows, '');
    renderOutput(lastPanel);
  }

  function renderFooter(preserveCursor = true) {
    if (!active) return;
    const { columns, rows } = terminalSize(output);
    let value = 'AUTO-COPY ON  ·  ';
    for (const item of FOOTER_ACTIONS) {
      const label = item.command === hoveredAction ? `\x1b[7m${item.label}\x1b[27m` : item.label;
      value += `${label} `;
    }
    const rendered = clip(value.trimEnd(), columns);
    output.write(`${preserveCursor ? '\x1b7' : ''}${CSI}${rows - 2};1H${CSI}2K${rendered}${preserveCursor ? '\x1b8' : ''}`);
  }

  function renderOutput(text) {
    lastPanel = String(text);
    if (!active) return;
    const { columns, rows } = terminalSize(output);
    const top = 6;
    const height = Math.max(1, rows - 9);
    const lines = fitPanelLines(lastPanel, columns, height);
    for (let index = 0; index < height; index++) writeAt(top + index, lines[index] || '');
  }

  function placePrompt(prompt) {
    if (!active) return;
    output.write(`${CSI}4;1H${CSI}2K${prompt}`);
  }

  function clearPrompt() {
    if (!active) return;
    output.write(`${CSI}4;1H${CSI}2K> `);
  }

  function start() {
    if (!enabled) return;
    active = true;
    output.write(`${CSI}?1049h${CSI}?1003h${CSI}?1006h${CSI}?25h${CSI}2J`);
    frame();
    output.on?.('resize', frame);
  }

  function updateShell() { frame(); }

  function finish() {
    if (!active) return;
    output.off?.('resize', frame);
    active = false;
    output.write(`${CSI}?1003l${CSI}?1006l${CSI}?1049l${CSI}?25h`);
  }

  function actionAt(column, row) {
    if (!active || row !== terminalSize(output).rows - 2) return null;
    return footerActionAt(column);
  }

  function setHover(action) {
    const next = FOOTER_ACTIONS.some((item) => item.command === action) ? action : null;
    if (next === hoveredAction) return;
    hoveredAction = next;
    renderFooter();
  }

  return { start, finish, renderOutput, placePrompt, clearPrompt, updateShell, actionAt, setHover, get active() { return active; } };
}
