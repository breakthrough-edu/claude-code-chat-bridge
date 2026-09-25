// The main loop, as a function you can build and drive from tests.
//
// bridge.mjs is the thin entry point that reads the environment, builds the Lark platform
// and calls createBridge(). The logic lives here so tests import THIS file and never the
// entry point: importing the file that starts your bot is how you end up with a second
// consumer on the same app.
//
// Per message, in this order:
//   1. drop it if its id was already handled (persisted, survives restarts);
//   2. drop it silently unless the sender is on the allowlist;
//   3. DMs always; in groups only when the bot is @-mentioned (checked here, in code:
//      a group can deliver every message to the bot, so this line is a privacy boundary);
//   4. text only, length cap, per-sender rate;
//   5. /new and /restart are handled here, before Claude is ever called;
//   6. everything else becomes a job in a one-at-a-time queue, acknowledged if it has to wait.
//
// Per job: a progress card with a Stop button, the hardened run from run-claude.mjs, a
// finished card with no button, then the reply.

import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPlatform } from './platform.mjs';
import { runClaude, cleanEnv, PIPE_FORCE_CLOSE_MS } from './run-claude.mjs';
import { openLedger } from './ledger.mjs';
import { openSessions, sessionKey } from './sessions.mjs';
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat.mjs';

// Every limit has a name. The eight cells ask for these by name (Limits cell).
export const LIMITS = {
  MAX_MESSAGE_CHARS: 4000,          // longer inbound messages are refused, not truncated
  MAX_REPLY_CHARS: 8000,            // longer replies are cut, with a note saying so
  MAX_QUEUE: 5,                     // waiting jobs; beyond this new messages are refused
  SEND_TIMEOUT_MS: 60_000,          // one outbound send, start to finish
  SEND_RETRIES: 2,                  // retries after the first failed send
  RETRY_BACKOFF_MS: 2000,           // doubled after every failed attempt
  MAX_SENDS_PER_RUN: 6,             // outbound messages and cards one job may create
  RATE_WINDOW_MS: 10 * 60_000,      // per-sender rate window
  RATE_MAX_PER_WINDOW: 20,          // messages one sender may send in that window
  IDLE_MS: 5 * 60_000,              // silence watchdog (paused while a tool is open)
  HARD_CAP_MS: 45 * 60_000,         // last backstop for a tool that never returns
  CARD_UPDATE_MIN_MS: 1000,         // progress card updates at most this often
  PROGRESS_LINES: 6,                // lines of progress shown on the card
  PIPE_FORCE_CLOSE_MS,              // after a group kill, force the pipes shut
  SHUTDOWN_WAIT_MS: 5000,           // how long SIGTERM waits for the running job to stop
};

// "5 minutes", "45 minutes", "30 seconds": chat text is read by a person, not a timer.
export function humanDuration(ms) {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
}

const STOP_MESSAGES = {
  idle: (l) => `No activity for ${humanDuration(l.IDLE_MS)}, stopped.`,
  hardcap: (l) => `Hit the hard cap of ${humanDuration(l.HARD_CAP_MS)}, stopped.`,
  user: () => 'Stopped.',
  shutdown: () => 'Stopped because the bridge is shutting down. Send it again once it is back if you still need it.',
  cage: () => 'CAGE BREACH: this run loaded tools or a permission mode I did not ask for, so I stopped it before it could act. Check the bridge log.',
};

export function progressLine(ev) {
  if (ev.type !== 'assistant') return null;
  for (const b of ev.message?.content || []) {
    if (b.type !== 'tool_use') continue;
    const file = b.input?.file_path ? basename(b.input.file_path) : '';
    if (b.name === 'Read') return `📖 reading ${file}`;
    if (b.name === 'Write') return `✍️ writing ${file}`;
    if (b.name === 'Edit') return `✏️ editing ${file}`;
    if (b.name === 'Glob' || b.name === 'Grep') return `🔎 searching`;
    return `🔧 ${b.name}`;
  }
  return null;
}

export function createBridge({
  platform,
  workdir,
  claudeBin,
  model,
  allowedUsers,                     // array of sender ids; empty means nobody, so start() refuses
  botId = '',                       // the bot's own id, for the @-mention check in groups
  stateDir,
  limits = {},
  childEnv = cleanEnv(),
  heartbeatUrl = null,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  fetchImpl,
  onRestart = () => process.exit(0),   // under launchd, KeepAlive brings it back
  onOtherCardAction = null,         // taps that are not Stop (for example an approval card)
  onJobDone = null,                 // (job, { state, platform, log }) after the reply is sent
  onFatal = () => process.exit(1),  // after a FATAL listener error and a clean shutdown; must not exit 0
  log = (...a) => console.log(new Date().toISOString(), ...a),
}) {
  const L = { ...LIMITS, ...limits };
  const allowed = new Set(allowedUsers || []);
  const ledgerFile = join(stateDir, 'ledger.json');
  const ledger = openLedger(ledgerFile);
  const sessions = openSessions(join(stateDir, 'sessions.json'));

  const queue = [];
  const rate = new Map();           // userId -> timestamps inside the window
  const subs = [];
  let current = null;               // { job, handle, deadline, stopRequested, finished }
  let busy = false;
  let stopping = false;
  let connection = 'starting';      // 'starting' | 'listening' | 'down' | 'closed', for the heartbeat
  const listeners = { messages: 'starting', cards: 'starting' };
  let fatalSeen = false;
  let heartbeat = null;
  let idleWaiters = [];

  // Sends: timeout, retries with backoff, and one idempotency key per logical send so a
  // retry after a timeout does not post the same message twice.
  async function sendWithRetry(label, fn) {
    for (let attempt = 0; attempt <= L.SEND_RETRIES; attempt++) {
      try {
        return await withTimeout(fn(), L.SEND_TIMEOUT_MS, label);
      } catch (err) {
        log(`send ${label} failed (attempt ${attempt + 1}):`, err.message);
        if (attempt < L.SEND_RETRIES) await sleep(L.RETRY_BACKOFF_MS * 2 ** attempt);
      }
    }
    return null;
  }

  function budgetOk(job) {
    job.sends = (job.sends || 0) + 1;
    if (job.sends > L.MAX_SENDS_PER_RUN) {
      log(`job ${job.id}: send budget of ${L.MAX_SENDS_PER_RUN} used up, dropping a send`);
      return false;
    }
    return true;
  }

  function say(job, kind, text) {
    if (!budgetOk(job)) return null;
    const key = `${job.id}:${kind}`;
    return sendWithRetry(key, () => platform.sendMessage({ chatId: job.chatId }, text, { idempotencyKey: key }));
  }

  // One-off replies that are not a job (refusals, /new).
  function reply(msg, kind, text) {
    const key = `${msg.eventId}:${kind}`;
    return sendWithRetry(key, () => platform.sendMessage({ chatId: msg.chatId }, text, { idempotencyKey: key }));
  }

  function rateOk(userId) {
    const now = Date.now();
    const recent = (rate.get(userId) || []).filter((t) => now - t < L.RATE_WINDOW_MS);
    recent.push(now);
    rate.set(userId, recent);
    return recent.length <= L.RATE_MAX_PER_WINDOW;
  }

  async function handleMessage(msg) {
    if (!msg?.eventId || stopping) return;
    if (ledger.hasSeen(msg.eventId)) { log(`duplicate ${msg.eventId}, ignored`); return; }
    ledger.markSeen(msg.eventId);

    if (!allowed.has(msg.userId)) { log(`ignored: sender not on the allowlist (${msg.eventId})`); return; }
    if (msg.chatType === 'group') {
      if (!botId || !(msg.mentions || []).some((m) => m.id === botId)) return;
    } else if (msg.chatType !== 'p2p') {
      return;
    }
    if (msg.messageType !== 'text') { log(`ignored: message type ${msg.messageType}`); return; }

    const text = String(msg.text || '').trim();
    if (!text) return;
    if (text.length > L.MAX_MESSAGE_CHARS) {
      return reply(msg, 'too-long', `That message is ${text.length} characters; the limit is ${L.MAX_MESSAGE_CHARS}.`);
    }
    if (!rateOk(msg.userId)) {
      return reply(msg, 'rate', `Too many messages in a short time. Try again in a few minutes.`);
    }

    const key = sessionKey(msg);
    if (text === '/new') {
      sessions.delete(key);
      return reply(msg, 'new', 'Started fresh.');
    }
    if (text === '/restart') {
      // Handled here, never by the agent: an agent that restarts its own bridge kills the
      // process that was going to send its reply.
      await reply(msg, 'restart', 'Restarting.');
      await shutdown('shutdown');
      return onRestart();
    }
    if (queue.length >= L.MAX_QUEUE) {
      return reply(msg, 'queue-full', `${queue.length} tasks are already waiting. Try again once they are done.`);
    }

    const job = {
      id: `job-${Date.now()}-${randomUUID().slice(0, 8)}`,
      eventId: msg.eventId,
      userId: msg.userId,
      chatId: msg.chatId,
      key,
      preview: text.slice(0, 40),
    };
    ledger.addJob(job);                         // the ledger keeps a preview, never the full text
    const queued = { ...job, text };
    queue.push(queued);

    const ahead = queue.length - 1 + (busy ? 1 : 0);
    if (ahead > 0) {
      say(queued, 'ack', `Got it. ${ahead} task${ahead > 1 ? 's' : ''} ahead of yours; I'll pick this up next.`);
    }
    pump();
  }

  function handleCardAction(action) {
    if (!action?.eventId) return;
    const id = `card:${action.eventId}`;
    if (ledger.hasSeen(id)) return;
    ledger.markSeen(id);
    // Same allowlist for tappers as for senders.
    if (!allowed.has(action.operatorId)) { log('ignored: card tap from someone not on the allowlist'); return; }

    const value = action.value || {};
    if (value.kind === 'stop') {
      // Handled right here, not through the queue: the queue is busy running the very job
      // this tap is trying to stop.
      if (current && current.job.id === value.job) {
        current.stopRequested = true;
        current.handle?.stop('user');
      } else {
        log(`stop tapped for ${value.job}, which is not running`);
      }
      return;
    }
    if (onOtherCardAction) {
      // May be async. A rejection here would be unhandled and take the whole bridge down,
      // so it is caught and logged, the same as a throw.
      Promise.resolve()
        .then(() => onOtherCardAction(action, { platform, allowed, log }))
        .catch((err) => log('card action handler failed:', err?.stack || err?.message || err));
      return;
    }
    log('ignored: unknown card action', JSON.stringify(value).slice(0, 200));
  }

  async function pump() {
    if (busy || stopping) return;
    const job = queue.shift();
    if (!job) {
      const w = idleWaiters; idleWaiters = [];
      w.forEach((r) => r());
      return;
    }
    busy = true;
    let resolveFinished;
    current = { job, handle: null, deadline: Date.now() + L.HARD_CAP_MS, stopRequested: false,
      finished: new Promise((r) => { resolveFinished = r; }) };
    try {
      await runJob(job);
    } catch (err) {
      log(`job ${job.id} crashed the loop:`, err.stack || err.message);
      ledger.setState(job.id, 'failed', { error: err.message });
    } finally {
      busy = false;
      current = null;
      resolveFinished();
      pump();
    }
  }

  async function runJob(job) {
    ledger.setState(job.id, 'running');
    const startedAt = Date.now();
    const lines = [];
    const stopButton = { text: 'Stop', type: 'danger', value: { kind: 'stop', job: job.id } };

    let cardId = null;
    if (budgetOk(job)) {
      const key = `${job.id}:card`;
      const sent = await sendWithRetry(key, () =>
        platform.sendCard({ chatId: job.chatId }, { title: 'Working', markdown: 'Starting...', buttons: [stopButton] }, { idempotencyKey: key }));
      cardId = sent?.cardId || null;
    }

    // Throttled, ordered card updates: at most one per CARD_UPDATE_MIN_MS.
    let chain = Promise.resolve();
    let lastAt = 0;
    let timer = null;
    const paint = (card) => {
      if (!cardId) return;
      chain = chain.then(() => withTimeout(platform.updateCard(cardId, card), L.SEND_TIMEOUT_MS, 'card'))
        .catch((err) => log('card update failed:', err.message));
    };
    const scheduleCard = () => {
      if (timer) return;
      const wait = Math.max(0, lastAt + L.CARD_UPDATE_MIN_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        lastAt = Date.now();
        paint({ title: 'Working', markdown: lines.slice(-L.PROGRESS_LINES).join('\n'), buttons: [stopButton] });
      }, wait);
    };

    const handle = runClaude({
      prompt: job.text,
      sessionId: sessions.get(job.key),
      workdir, claudeBin, model,
      env: childEnv,
      idleMs: L.IDLE_MS,
      hardCapMs: L.HARD_CAP_MS,
      pipeForceMs: L.PIPE_FORCE_CLOSE_MS,
      log,
      onSpawn: (pid) => ledger.recordPid(pid),
      onEvent: (ev) => {
        const line = progressLine(ev);
        if (line) { lines.push(line); scheduleCard(); }
      },
    });
    current.handle = handle;
    if (current.stopRequested) handle.stop('user');   // tapped before the spawn finished

    const res = await handle.done;
    ledger.clearPid();
    clearTimeout(timer);
    await chain;

    let state; let title; let text;
    if (res.cageBreach) {
      state = 'failed'; title = 'Refused'; text = STOP_MESSAGES.cage(L);
    } else if (res.stoppedReason) {
      state = 'stopped'; title = 'Stopped'; text = STOP_MESSAGES[res.stoppedReason](L);
    } else if (!res.sawResult) {
      // The child died without a result. It may have written part of its work already,
      // so this is reported, never retried automatically.
      state = 'failed'; title = 'Failed';
      const why = res.stderr ? ` ${res.stderr.trim().split('\n')[0].slice(0, 200)}` : '';
      text = `The run ended without a result (exit ${res.exitCode}).${why} It may have done part of the work before it stopped; check before sending it again.`;
    } else if (res.isError) {
      state = 'failed'; title = 'Failed';
      text = `The run reported an error: ${(res.text || res.stderr || 'no detail').slice(0, 500)}`;
    } else {
      state = 'done'; title = 'Done';
      text = res.text || '(empty reply)';
      if (res.retriedFresh) text = `(The earlier conversation was gone, so this started fresh.)\n\n${text}`;
    }
    if (text.length > L.MAX_REPLY_CHARS) text = `${text.slice(0, L.MAX_REPLY_CHARS)}\n\n(reply cut at ${L.MAX_REPLY_CHARS} characters)`;

    sessions.recordResult(job.key, res);
    // The outcome is known, the reply is not sent yet. If the bridge dies before the send is
    // confirmed, startup sees `replying` and tells the user, instead of a `done` that nobody heard.
    ledger.setState(job.id, 'replying', {
      outcome: state, stoppedReason: res.stoppedReason, exitCode: res.exitCode,
      permissionDenials: res.permissionDenials.length, cageBreach: res.cageBreach,
    });

    // Finished card: re-rendered whole, with NO buttons, so nothing live-looking is left behind.
    const summary = [...lines.slice(-L.PROGRESS_LINES), '', `**${title}**`].join('\n').trim();
    paint({ title, markdown: summary, buttons: [] });
    await chain;
    // The key stays `<job>:reply` across retries, so a retry after a send that did land is
    // dropped by the platform instead of delivered twice.
    const sent = await say(job, 'reply', text);
    const delivered = Boolean(sent);
    ledger.setState(job.id, state, { replyDelivered: delivered });
    // One line per finished job. "NOT confirmed" means the send failed after its retries or
    // the job's send budget was used up; the job itself still ended as `state`.
    const secs = Math.round((Date.now() - startedAt) / 1000);
    log(`job ${job.id} ${state} in ${secs}s; ${delivered ? 'reply sent' : 'reply NOT confirmed sent'}`);
    await afterJob(job, state);
  }

  // The hook for work that must happen after a run and before the next one starts, such as
  // collecting drafts the model left for an approval card. It runs inside the job, so the
  // next run cannot touch what this one left behind until the hook has finished.
  async function afterJob(job, state) {
    if (!onJobDone) return;
    try {
      await onJobDone(job, { state, platform, log });
    } catch (err) {
      log(`job ${job.id}: onJobDone failed:`, err?.stack || err?.message || err);
    }
  }

  // Both listeners must be up for 'listening'. With either one down the bridge is partly
  // deaf (no messages, or no Stop button), and the heartbeat says so.
  function setListener(which, state) {
    // After a FATAL every listener is down, including one that is only being closed.
    listeners[which] = fatalSeen && state === 'closed' ? 'down' : state;
    const all = Object.values(listeners);
    if (stopping) connection = fatalSeen ? 'down' : 'closed';
    else if (all.every((s) => s === 'listening')) connection = 'listening';
    else if (all.some((s) => s === 'down' || s === 'closed')) connection = 'down';
    else connection = 'starting';
    heartbeat?.beat();                     // write the change now, not at the next minute
  }

  // A listener error that restarting cannot fix. Say it plainly, stop cleanly, exit non-zero.
  async function fatal(message) {
    if (fatalSeen) return;
    fatalSeen = true;
    // Both listeners are down now: the failing one, and the other one, which shutdown()
    // closes (its child is killed and any pending restart is cancelled).
    for (const k of Object.keys(listeners)) listeners[k] = 'down';
    connection = 'down';
    log(`FATAL: ${message}`);
    await shutdown('shutdown');
    onFatal(message);
  }

  async function shutdown(reason = 'shutdown') {
    if (stopping) return;
    stopping = true;
    subs.forEach((s) => { try { s.close(); } catch {} });
    // The subscriptions are closed now, so the bridge is not listening, whatever state the
    // listener processes report on their way out (and the process may exit before they do).
    const last = fatalSeen ? 'down' : 'closed';     // a fatal stop leaves the last word as 'down'
    for (const k of Object.keys(listeners)) listeners[k] = last;
    connection = last;
    heartbeat?.stop();
    if (current) {
      current.handle?.stop(reason);
      await Promise.race([current.finished, sleep(L.SHUTDOWN_WAIT_MS)]);
    }
    // Jobs still waiting never started: tell their senders now rather than leave them hanging.
    for (const job of queue.splice(0)) {
      ledger.setState(job.id, 'dropped');
      await say(job, 'dropped', 'The bridge is shutting down before this started. Send it again once it is back.');
    }
    await heartbeat?.beat();                // the final beat: connection and both listeners closed
  }

  async function start() {
    assertPlatform(platform);
    if (allowed.size === 0) throw new Error('allowlist is empty: refusing to start (nobody could use it, and that is usually a config mistake)');
    if (!workdir || !claudeBin) throw new Error('workdir and claudeBin are required');

    // 1. A crash leaves the detached claude group running with nobody listening. Kill it.
    killOrphan(ledger.runningPid, claudeBin, log);
    ledger.clearPid();

    // 2. Jobs that were running when the bridge died are NOT rerun. Tell their users.
    for (const job of ledger.recoverAfterRestart()) {
      let text;
      if (job.interruptedWhile === 'replying') {
        text = `The run for "${job.preview}" finished, but the bridge restarted before its reply was confirmed, so the reply may not have reached you. I did not rerun it; please ask again.`;
      } else if (job.state === 'interrupted') {
        text = `The bridge restarted while working on "${job.preview}". I did not rerun it, because it may have done part of the work already. Check, then send it again if needed.`;
      } else {
        text = `The bridge restarted before starting "${job.preview}". Send it again if you still need it.`;
      }
      await say(job, 'restart-notice', text);
      // Whatever an interrupted run left behind (a half-written draft) is handled as the
      // leftovers of a run that did not finish, never as the next run's output.
      await afterJob(job, job.state);
    }

    // 3. Listen.
    subs.push(platform.consumeMessages((m) => { handleMessage(m).catch((e) => log('message handler:', e.message)); },
      { onState: (s) => setListener('messages', s), onFatal: fatal }));
    subs.push(platform.onCardAction((a) => {
      try { handleCardAction(a); } catch (e) { log('card handler:', e.message); }
    }, { onState: (s) => setListener('cards', s), onFatal: fatal }));

    heartbeat = startHeartbeat({
      file: join(stateDir, 'heartbeat.json'),
      intervalMs: heartbeatIntervalMs,
      pingUrl: heartbeatUrl,
      fetchImpl,
      log,
      getStatus: () => ({
        job: current ? { id: current.job.id, deadline: new Date(current.deadline).toISOString() } : null,
        connection,
        listeners: { ...listeners },
        queued: queue.length,
      }),
    });
    log(`bridge started; ${allowed.size} allowed sender(s); groups ${botId ? 'on (mention only)' : 'off'}`);
  }

  return {
    start,
    shutdown,
    // Resolves once the queue is empty and nothing is running. For tests.
    whenIdle() {
      if (!busy && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },
    get currentJob() { return current?.job || null; },
    ledger,
    sessions,
  };
}

// Kill a claude process group recorded before a crash, if it is still alive AND still ours.
// The pid check guards against pid reuse: after a reboot that number may belong to anything.
export function killOrphan(pid, claudeBin, log = console.log) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }            // not alive
  let cmd = '';
  try { cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return false; }
  if (!cmd.includes(basename(claudeBin))) {
    log(`recorded pid ${pid} now belongs to something else; leaving it alone`);
    return false;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  log(`killed orphaned claude group ${pid} left over from a crash`);
  return true;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
