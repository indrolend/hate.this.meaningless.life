const CLEAR_LINE = '\r\x1b[2K';
const RUNNING_FACES = ['(o_o)', '(O_o)', '(O_O)', '(o_O)'];
const PARTICLES = ['⠂', '⠒', '⠤', '⠲', '⠴', '⠦', '⠖', '⠶'];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fit(value, width) {
  const text = String(value);
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text.padEnd(width);
}

export function particleMorphFrames(from, to) {
  const width = Math.max(String(from).length, String(to).length);
  const before = fit(from, width);
  const after = fit(to, width);
  const scatter = (phase) => Array.from({ length: width }, (_, index) => PARTICLES[(index * 3 + phase) % PARTICLES.length]).join('');
  return [
    before,
    Array.from(before, (character, index) => index % 2 ? PARTICLES[(index + 1) % PARTICLES.length] : character).join(''),
    scatter(2),
    Array.from(after, (character, index) => index % 2 ? character : PARTICLES[(index + 4) % PARTICLES.length]).join(''),
    after,
  ];
}

export function visualMotionEnabled({ interactive, requested = true, env = process.env } = {}) {
  return Boolean(interactive && requested && env.TERM !== 'dumb'
    && env.COMMANDHUD_REDUCED_MOTION !== '1' && env.REDUCE_MOTION !== '1');
}

export function createShellVisualStatus(output, { enabled = true, animated = true, frameMs = 140, row = null, showFace = true } = {}) {
  let timer = null;
  let faceIndex = 0;
  let commandLabel = '';

  function draw(faceValue, state) {
    const value = `${showFace ? `${faceValue} ` : ''}${state}${commandLabel ? ` · ${commandLabel}` : ''}`;
    output.write(row ? `\x1b7\x1b[${row};1H\x1b[2K${value}\x1b8` : `${CLEAR_LINE}${value}`);
  }

  return {
    start(command) {
      if (!enabled) return;
      commandLabel = fit(command, 52).trimEnd();
      draw(RUNNING_FACES[0], 'RUNNING');
      if (!animated) return;
      timer = setInterval(() => {
        faceIndex = (faceIndex + 1) % RUNNING_FACES.length;
        draw(RUNNING_FACES[faceIndex], 'RUNNING');
      }, frameMs);
      timer.unref?.();
    },

    async finish(status) {
      if (!enabled) return;
      if (timer) clearInterval(timer);
      timer = null;
      const stopped = status === 'interrupted' || status === 'cancelled';
      const finalState = status === 'pass' ? 'PASS' : stopped ? 'STOPPED' : 'FAIL';
      const finalFace = status === 'pass' ? '(^_^)' : stopped ? '(-_-)' : '(x_x)';
      if (!animated) {
        draw(finalFace, finalState);
        return;
      }
      for (const frame of particleMorphFrames('RUNNING', finalState)) {
        draw(finalFace, frame);
        await wait(Math.min(frameMs, 90));
      }
      if (!row) output.write('\n');
    },

    clear() {
      if (timer) clearInterval(timer);
      timer = null;
      if (enabled && !row) output.write(CLEAR_LINE);
    },
  };
}

export const IDLE_FACE = '(._.)';
