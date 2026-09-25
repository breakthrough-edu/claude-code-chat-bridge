// Not a test file. A bridge process that the crash test starts and then kills with SIGKILL,
// to reproduce a real crash: no shutdown handler runs, the ledger says `running`, and the
// detached claude child is left alive with nobody listening.
//
// Usage: node crash-harness.mjs <stateDir> <workdir> <fakeLog> <pidFile> [scenario]
//   mid-run (default)  prints "RUNNING <claude pid>" once the job is running mid-write
//   before-reply       the run finishes, the reply send never completes; prints "REPLYING"
//                      once the ledger says `replying`
// Then it waits to be killed.

import { createBridge } from '../loop.mjs';
import { createFakePlatform } from './fake-platform.mjs';
import { FAKE_CLAUDE, FAST_LIMITS, ME, fakeEnv, waitUntil } from './helpers.mjs';

const [stateDir, workdir, fakeLog, pidFile, scenario = 'mid-run'] = process.argv.slice(2);
const dirs = { stateDir, workdir, fakeLog, pidFile };

const fake = createFakePlatform();
if (scenario === 'before-reply') {
  // The reply send hangs, as if the process died while it was on the wire.
  const send = fake.platform.sendMessage;
  fake.platform.sendMessage = (target, text, opts = {}) =>
    String(opts.idempotencyKey || '').endsWith(':reply') ? new Promise(() => {}) : send(target, text, opts);
}
const bridge = createBridge({
  platform: fake.platform,
  workdir,
  claudeBin: FAKE_CLAUDE,
  allowedUsers: [ME],
  stateDir,
  limits: { ...FAST_LIMITS, IDLE_MS: 60_000, HARD_CAP_MS: 120_000 },
  childEnv: fakeEnv(dirs, scenario === 'before-reply' ? 'normal' : 'write-then-hang'),
  log: () => {},
});

await bridge.start();
fake.inject({ eventId: 'om_test_crash', userId: ME, chatId: 'oc_test_dm', text: 'write the report' });
if (scenario === 'before-reply') {
  await waitUntil(() => bridge.ledger.jobs().some((j) => j.state === 'replying'), 5000);
  process.stdout.write('REPLYING\n');
  setInterval(() => {}, 1 << 30);
} else {
await waitUntil(() => bridge.ledger.runningPid && bridge.ledger.jobs().some((j) => j.state === 'running'), 5000);
// Give the fake time to do its Write, so the "half-done work" is real.
await new Promise((r) => setTimeout(r, 200));
process.stdout.write(`RUNNING ${bridge.ledger.runningPid}\n`);
setInterval(() => {}, 1 << 30);
}
