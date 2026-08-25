import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHudServer } from './server.mjs';

function processAppearsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function acquireDesktopLock(project) {
  const directory = join(project.store, 'desktop');
  const path = join(directory, `${project.key}.lock.json`);
  mkdirSync(directory, { recursive: true });
  const existing = readJson(path);
  if (existing && processAppearsAlive(existing.pid)) {
    throw new Error(`CommandHUD desktop is already active for this repository (pid ${existing.pid}).`);
  }
  if (existsSync(path)) rmSync(path, { force: true });
  const token = randomBytes(12).toString('hex');
  const descriptor = openSync(path, 'wx');
  try { writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, root: project.root, startedAt: new Date().toISOString() }, null, 2)}\n`); }
  finally { closeSync(descriptor); }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      if (readJson(path)?.token === token) rmSync(path, { force: true });
    },
  };
}

export function findDesktopBrowser({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return null;
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  const installed = candidates.find((path) => exists(path));
  if (installed) return installed;
  for (const name of ['msedge.exe', 'chrome.exe']) {
    const located = spawnSync('where.exe', [name], { windowsHide: true, encoding: 'utf8' });
    const path = located.status === 0 ? located.stdout.split(/\r?\n/).find(Boolean) : null;
    if (path) return path.trim();
  }
  return null;
}

export async function startDesktopHud(project, {
  browserPath = null,
  spawnImpl = spawn,
  serverFactory = startHudServer,
  rendererStartupMs = 15000,
  rendererDisconnectMs = 750,
} = {}) {
  const lock = acquireDesktopLock(project);
  let running = null;
  let child = null;
  let closed = false;
  let rendererConnected = false;
  let disconnectTimer = null;
  let resolveRendererClosed;
  const rendererClosed = new Promise((resolve) => { resolveRendererClosed = resolve; });
  const onSessionClientsChanged = (count) => {
    if (count > 0) {
      rendererConnected = true;
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = null;
      return;
    }
    if (!rendererConnected || disconnectTimer) return;
    disconnectTimer = setTimeout(() => resolveRendererClosed({ reason: 'renderer-closed' }), rendererDisconnectMs);
  };
  const close = async ({ terminateBrowser = false } = {}) => {
    if (closed) return;
    closed = true;
    if (terminateBrowser && child?.exitCode === null) child.kill();
    if (running?.server) await new Promise((resolveClose) => running.server.close(resolveClose));
    lock.release();
  };
  try {
    running = await serverFactory(project, {
      host: '127.0.0.1', port: 0, terminal: true, onSessionClientsChanged,
    });
    const executable = browserPath || findDesktopBrowser();
    if (!executable) throw new Error('CommandHUD desktop requires Microsoft Edge or Google Chrome on Windows.');
    const url = `http://${running.host}:${running.port}/`;
    const profile = join(project.store, 'desktop', 'profiles', project.key);
    mkdirSync(profile, { recursive: true });
    child = spawnImpl(executable, [
      `--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run',
      '--disable-background-mode', '--disable-features=msEdgeFirstRunExperience',
    ], { windowsHide: true, stdio: 'ignore' });
    const browserError = new Promise((_, rejectError) => child.once('error', rejectError));
    const exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    const failedToConnect = new Promise((resolveFailure) => {
      const timer = setTimeout(() => {
        if (!rendererConnected) resolveFailure({ reason: 'renderer-never-connected' });
      }, rendererStartupMs);
      timer.unref?.();
    });
    return {
      url, browser: executable, pid: child.pid, recovery: running.recovery,
      close,
      async wait() {
        try { return await Promise.race([rendererClosed, failedToConnect, browserError]); }
        finally { await close(); }
      },
    };
  } catch (error) {
    await close({ terminateBrowser: true });
    throw error;
  }
}
