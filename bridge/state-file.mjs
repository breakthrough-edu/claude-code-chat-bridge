// Small helpers for the JSON state files (ledger, sessions, heartbeat).
//
// Every write goes to a temp file first and is then renamed over the real one.
// A rename on the same filesystem is atomic, so a crash in the middle of a write
// leaves either the old file or the new one, never half of each. A half-written
// ledger is worse than none: it could make the bridge forget which jobs it ran.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A corrupt state file is worth a loud log line, not a crash loop under launchd.
    console.error(`state file ${file} unreadable, starting from empty:`, err.message);
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}
