#!/usr/bin/env node
// Entry point: `node bridge/bridge.mjs` (or the launchd plist next to this file).
//
// This file only reads configuration and wires the pieces together. The loop itself is in
// loop.mjs. main() runs only when this file is executed directly, never when imported,
// and the tests never import it at all. To check that it loads, use `node --check`.
//
// Configuration comes from the environment only. Under launchd it is in the plist
// (com.example.chat-bridge.plist). For a foreground run, copy example.env to .env and run
//   node --env-file=bridge/.env bridge/bridge.mjs      (Node 20.6 or later)
// Variables:
//   BRIDGE_WORKDIR         required. The only directory the agent works in.
//   CLAUDE_BIN             required. Absolute path to claude (`which -a claude`, the line
//                          that starts with /). The child's PATH is scrubbed, so a bare
//                          'claude' fails with spawn ENOENT.
//   BRIDGE_ALLOWED_USERS   required. Comma-separated sender ids (Lark: ou_xxx). Only these
//                          may send messages or tap buttons.
//   BRIDGE_BOT_ID          optional. The bot's own id. Without it, group messages are ignored.
//   BRIDGE_STATE_DIR       optional. Ledger, sessions and heartbeat files. Default ./state
//                          (relative to the plist's WorkingDirectory).
//   BRIDGE_MODEL           optional. Default claude-sonnet-5; a fast model is plenty for dispatch.
//   BRIDGE_IDLE_MS         optional. Silence watchdog, default 5 minutes.
//   BRIDGE_HARD_CAP_MS     optional. Hard cap, default 45 minutes.
//   BRIDGE_HEARTBEAT_URL   optional. Outside ping for a dead-man's-switch service. Off if unset.
//   BRIDGE_OUTSIDE_DIR     optional. Absolute folder OUTSIDE BRIDGE_WORKDIR that the one carded
//                          action writes into (bridge/actions/write-outside.mjs). Unset means
//                          approval cards are off: drafts in <WORKDIR>/outbox/ are not read.
//   LARK_CLI, LARK_PROFILE see platform-lark.mjs.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, LIMITS } from './loop.mjs';
import { createLarkPlatform } from './platform-lark.mjs';
import { createApproval } from './approval.mjs';
import { createWriteOutside } from './actions/write-outside.mjs';

export function configFromEnv(env = process.env) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const num = (v, d) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    workdir: env.BRIDGE_WORKDIR,
    claudeBin: env.CLAUDE_BIN,
    allowedUsers: list(env.BRIDGE_ALLOWED_USERS),
    botId: env.BRIDGE_BOT_ID || '',
    stateDir: resolve(env.BRIDGE_STATE_DIR || 'state'),
    model: env.BRIDGE_MODEL || 'claude-sonnet-5',
    heartbeatUrl: env.BRIDGE_HEARTBEAT_URL || null,
    outsideDir: env.BRIDGE_OUTSIDE_DIR || null,
    limits: {
      IDLE_MS: num(env.BRIDGE_IDLE_MS, LIMITS.IDLE_MS),
      HARD_CAP_MS: num(env.BRIDGE_HARD_CAP_MS, LIMITS.HARD_CAP_MS),
    },
  };
}

async function main() {
  const { outsideDir, ...config } = configFromEnv();
  const platform = createLarkPlatform();

  // Approval cards (docs/approval-card.md), only when a folder outside the cage is set.
  // write-outside refuses a folder that overlaps the working directory.
  let approval = null;
  if (outsideDir) {
    const writeOutside = createWriteOutside({ outsideDir, workdir: config.workdir });
    approval = createApproval({
      platform,
      stateDir: config.stateDir,
      workdir: config.workdir,
      actions: { [writeOutside.name]: writeOutside },
    });
    // A draft left mid-action by a crash goes back to pending; overdue ones expire.
    await approval.recover();
  }

  let exiting = false;
  const bridge = createBridge({
    ...config,
    platform,
    // A listener error no restart can fix (for example a disabled app). The loop has logged
    // FATAL and shut down cleanly; exit non-zero so launchd's "last exit code" shows it.
    onFatal: async () => {
      exiting = true;
      await approval?.settled();
      process.exit(1);
    },
    onOtherCardAction: approval ? (a) => approval.handleAction(a) : null,
    onJobDone: approval
      ? (job, { state }) => approval.collectOutbox({ chatId: job.chatId, jobId: job.id, runOk: state === 'done' })
      : null,
  });

  // Clean shutdown: stop the running job (kill its group), tell waiting senders, exit.
  // launchd sends SIGTERM on bootout; KeepAlive restarts us after a crash or /restart.
  const onSignal = async (sig) => {
    if (exiting) return;
    exiting = true;
    console.log(new Date().toISOString(), `${sig}: shutting down`);
    await bridge.shutdown('shutdown');
    await approval?.settled();            // let a tap that is mid-write finish its read-back
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // A long-running bridge never finishes on its own. If the event loop ever empties (every
  // listener gone and nothing scheduled), Node would exit with code 0 and launchd would
  // record a clean exit. Make that impossible to miss.
  process.on('beforeExit', () => {
    if (exiting) return;
    console.error(new Date().toISOString(), 'FATAL: nothing left running (all listeners gone); exiting 1');
    process.exit(1);
  });

  await bridge.start();
}

// Run only when executed directly: `node bridge/bridge.mjs`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(new Date().toISOString(), 'bridge failed to start:', err.message);
    process.exit(1);
  });
}
