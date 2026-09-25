// Heartbeat (docs/heartbeat.md): three layers, and the bridge can only do the first two.
//
//   1. A state file written every 60 s: timestamp, current job and its deadline, and the
//      listener's connection state. Something else reads it.
//   2. A separate watcher on the same machine (a launchd job you write) that alerts when
//      the timestamp goes stale or a job overruns its deadline.
//   3. Something OUTSIDE the machine that notices when the pings stop. If the whole machine
//      is off, layers 1 and 2 are off with it. The optional ping URL below is for a
//      dead-man's-switch style service: it expects a ping on a schedule and alerts you
//      when the pings stop. Off by default. If you have none, write "only on-machine; a
//      dead machine is invisible" in your eight cells instead of leaving the cell blank.
//
// The ping is sent only while the listener is up, so "bridge running but deaf" also
// stops the pings and the outside service notices.

import { writeJsonAtomic } from './state-file.mjs';

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const PING_TIMEOUT_MS = 10_000;

export function startHeartbeat({
  file,
  getStatus,                        // () => { job: {id, deadline} | null, connection: string, listeners? }
  intervalMs = HEARTBEAT_INTERVAL_MS,
  pingUrl = null,                   // e.g. process.env.BRIDGE_HEARTBEAT_URL; null = no outside ping
  fetchImpl = globalThis.fetch,     // injectable so tests never touch the network
  log = console.log,
  now = () => new Date(),
}) {
  let lastPingOk = null;

  async function beat() {
    const status = getStatus();
    const record = {
      ts: now().toISOString(),
      pid: process.pid,
      job: status.job || null,
      connection: status.connection,
      listeners: status.listeners || null,
      lastPingOk,
    };
    try {
      writeJsonAtomic(file, record);
    } catch (err) {
      log('heartbeat write failed:', err.message);
    }

    if (pingUrl && status.connection === 'listening') {
      try {
        const res = await fetchImpl(pingUrl, { method: 'GET', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
        lastPingOk = Boolean(res?.ok);
        if (!lastPingOk) log('heartbeat ping answered', res?.status);
      } catch (err) {
        lastPingOk = false;
        log('heartbeat ping failed:', err.message);
      }
    }
    return record;
  }

  const timer = setInterval(beat, intervalMs);
  timer.unref();
  beat();

  return {
    beat,
    stop() { clearInterval(timer); },
  };
}
