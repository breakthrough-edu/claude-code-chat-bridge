// Shared setup for the offline tests: temp dirs, the fake claude, tiny timings, cleanup.

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from '../run-claude.mjs';

export const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
export const ME = 'ou_test_owner';           // placeholder ids, never real ones
export const STRANGER = 'ou_test_stranger';
export const BOT = 'ou_test_bot';

// Compressed clock: minutes become about a second. The idle window must still cover a
// cold node start of the fake (a few hundred ms on a busy machine), or the watchdog fires
// before init: the same thing would happen to a real claude with a too-tight window.
export const FAST_LIMITS = {
  IDLE_MS: 1000,
  HARD_CAP_MS: 3000,
  PIPE_FORCE_CLOSE_MS: 200,
  CARD_UPDATE_MIN_MS: 30,
  RETRY_BACKOFF_MS: 10,
  SHUTDOWN_WAIT_MS: 2000,
};

export function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  return {
    root,
    workdir: mkdtempSync(join(root, 'work-')),
    stateDir: join(root, 'state'),
    fakeLog: join(root, 'fake-claude.log'),
    pidFile: join(root, 'grandchildren.json'),
  };
}

// The scrubbed env the bridge really uses, plus the node binary's folder (the fake is a
// node script) and the knobs that script the fake.
export function fakeEnv(dirs, mode, extra = {}) {
  const base = cleanEnv();
  return {
    ...base,
    PATH: `${dirname(process.execPath)}:${base.PATH}`,
    FAKE_CLAUDE_MODE: mode,
    FAKE_CLAUDE_TICK_MS: '20',
    FAKE_CLAUDE_LOG: dirs.fakeLog,
    FAKE_CLAUDE_PIDFILE: dirs.pidFile,
    ...extra,
  };
}

// How many times the fake claude was started, and with which argv.
export function fakeRuns(dirs) {
  if (!existsSync(dirs.fakeLog)) return [];
  return readFileSync(dirs.fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function grandchildren(dirs) {
  if (!existsSync(dirs.pidFile)) return {};
  return JSON.parse(readFileSync(dirs.pidFile, 'utf8'));
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitUntil(pred, timeoutMs = 5000, stepMs = 20) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

// Kill anything a test left running, so a failing test never leaks processes.
export function killQuietly(pid, group = false) {
  if (!pid) return;
  try { process.kill(group ? -pid : pid, 'SIGKILL'); } catch {}
}

export function collectLog() {
  const lines = [];
  const log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  log.lines = lines;
  log.has = (s) => lines.some((l) => l.includes(s));
  return log;
}
