const CSI = '\x1b[';
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const FOOTER_ACTIONS = [
  { label: '[ COPY OUTPUT ]', id: 'copy' },
  { label: '[ RAW ]', id: 'raw' },
  { label: '[ UNDO ]', id: 'undo' },
  { label: '[ HELP ]', id: 'help' },
  { label: '[ EXIT ]', id: 'exit' },
];

function footerText() {
  return `AUTO-COPY ON  ·  ${FOOTER_ACTIONS.map((item) => item.label).join(' ')}`;
}

export function footerActionAt(column, footer = footerText()) {
  for (const item of FOOTER_ACTIONS) {
    const start = footer.indexOf(item.label) + 1;
    if (start > 0 && column >= start && column < start + item.label.length) return item.id;
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

export function visibleWidth(value) {
  return [...String(value).replace(ANSI_PATTERN, '')].length;
}

export function clipAnsi(text, width) {
  const source = String(text).replaceAll('\t', '  ');
  if (visibleWidth(source) <= width) return source;
  const target = Math.max(0, width - 1);
  let visible = 0;
  let result = '';
  for (let index = 0; index < source.length && visible < target;) {
    if (source[index] === '\x1b') {
      const match = source.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) { result += match[0]; index += match[0].length; continue; }
    }
    const point = String.fromCodePoint(source.codePointAt(index));
    result += point;
    index += point.length;
    visible++;
  }
  return `${result}\x1b[0m…`;
}

function terminalSize(output) {
  return {
    columns: Math.max(1, Number(output.columns) || 80),
    rows: Math.max(8, Number(output.rows) || 24),
  };
}

function clip(text, width) {
  return clipAnsi(String(text).replace(ANSI_PATTERN, ''), width);
}

export function fitPanelLines(text, width, height) {
  const lines = String(text).replace(ANSI_PATTERN, '').split(/\r?\n/).map((line) => clip(line, width));
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
  let focusedAction = null;

  function writeAt(row, value, preserveCursor = false) {
    output.write(`${preserveCursor ? '\x1b7' : ''}${CSI}${row};1H${CSI}2K${value}${preserveCursor ? '\x1b8' : ''}`);
  }

  function renderFooter(preserveCursor = true) {
    if (!active) return;
    const { columns, rows } = terminalSize(output);
    let value = 'AUTO-COPY ON  ·  ';
    for (const item of FOOTER_ACTIONS) {
      const focused = item.id === focusedAction;
      const hovered = item.id === hoveredAction;
      const label = focused ? `\x1b[1;7m${item.label}\x1b[0m` : hovered ? `\x1b[7m${item.label}\x1b[27m` : item.label;
      value += `${label} `;
    }
    writeAt(rows, clipAnsi(value.trimEnd(), columns), preserveCursor);
  }

  function renderOutput(text) {
    lastPanel = String(text);
    if (!active) return;
    const { columns, rows } = terminalSize(output);
    const top = 6;
    const height = Math.max(0, rows - 8);
    const lines = fitPanelLines(lastPanel, columns, height);
    for (let index = 0; index < height; index++) writeAt(top + index, lines[index] || '', true);
  }

  function frame() {
    if (!active) return;
    const { columns, rows } = terminalSize(output);
    const rule = '─'.repeat(columns);
    writeAt(1, clip('(._.)  hate.this.meaningless.life  ·  context condenser', columns), true);
    writeAt(2, focusedAction ? `CONTROLS · ${focusedAction.toUpperCase()} · Enter activates · Esc returns to command` : 'COMMAND INPUT', true);
    writeAt(3, rule, true);
    writeAt(5, rule, true);
    writeAt(rows - 2, rule, true);
    renderFooter(true);
    renderOutput(lastPanel);
  }

  function placePrompt() {
    if (!active) return;
    writeAt(4, '', false);
  }

  function clearPrompt() {
    if (!active) return;
    writeAt(4, '', false);
  }

  function start() {
    if (!enabled || active) return;
    active = true;
    output.on?.('resize', frame);
    output.write(`${CSI}?1049h${CSI}?1003h${CSI}?1006h${CSI}?25h${CSI}2J`);
    frame();
  }

  function updateShell() { frame(); }

  function finish() {
    if (!active) return;
    output.off?.('resize', frame);
    active = false;
    output.write(`${CSI}?1003l${CSI}?1006l${CSI}?1049l${CSI}?25h`);
  }

  function actionAt(column, row) {
    if (!active || row !== terminalSize(output).rows) return null;
    return footerActionAt(column);
  }

  function setHover(action) {
    const next = FOOTER_ACTIONS.some((item) => item.id === action) ? action : null;
    if (next === hoveredAction) return;
    hoveredAction = next;
    renderFooter(true);
  }

  function setFocus(action) {
    const next = FOOTER_ACTIONS.some((item) => item.id === action) ? action : null;
    if (next === focusedAction) return focusedAction;
    focusedAction = next;
    frame();
    if (focusedAction) {
      writeAt(4, '', false);
      output.write(`${CSI}?25l`);
    } else output.write(`${CSI}?25h`);
    return focusedAction;
  }

  function moveFocus(direction = 1) {
    const current = FOOTER_ACTIONS.findIndex((item) => item.id === focusedAction);
    const index = current < 0 ? (direction < 0 ? FOOTER_ACTIONS.length - 1 : 0)
      : (current + direction + FOOTER_ACTIONS.length) % FOOTER_ACTIONS.length;
    return setFocus(FOOTER_ACTIONS[index].id);
  }

  return {
    start, finish, renderOutput, placePrompt, clearPrompt, updateShell, actionAt, setHover, setFocus, moveFocus,
    get focusedAction() { return focusedAction; },
    get active() { return active; },
  };
}
