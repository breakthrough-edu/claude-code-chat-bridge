// The whole loop, offline: fake platform in, fake claude underneath.
// Every scenario here is one the README says to test before trusting the bridge.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../loop.mjs';
import { openLedger } from '../ledger.mjs';
import { createFakePlatform } from './fake-platform.mjs';
import {
  FAKE_CLAUDE, FAST_LIMITS, ME, STRANGER, BOT, tempDirs, fakeEnv, fakeRuns, grandchildren,
  isAlive, waitUntil, killQuietly, collectLog,
} from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const running = [];
afterEach(async () => {
  for (const b of running.splice(0)) await b.shutdown();
});

function makeBridge(dirs, mode, { limits = {}, extraEnv, botId } = {}) {
  const fake = createFakePlatform();
  const log = collectLog();
  const bridge = createBridge({
    platform: fake.platform,
    workdir: dirs.workdir,
    claudeBin: FAKE_CLAUDE,
    allowedUsers: [ME],
    botId,
    stateDir: dirs.stateDir,
    limits: { ...FAST_LIMITS, ...limits },
    childEnv: fakeEnv(dirs, mode, extraEnv),
    onRestart: () => {},
    log,
  });
  running.push(bridge);
  return { bridge, fake, log };
}

const dm = (eventId, text, userId = ME) => ({ eventId, userId, chatId: 'oc_test_dm', chatType: 'p2p', text });
const replies = (fake) => fake.sent.map((s) => s.text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('normal: progress card with Stop, finished card without it, reply, session stored', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'normal');
  await bridge.start();
  fake.inject(dm('om_1', 'summarise my notes'));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send

  const [card] = [...fake.cards.values()];
  assert.equal(card.history[0].buttons[0].value.kind, 'stop');
  const final = card.history[card.history.length - 1];
  assert.equal(final.title, 'Done');
  assert.deepEqual(final.buttons, [], 'finished card has no live-looking button');
  assert.match(fake.sent[0].text, /^ok: summarise my notes/);
  assert.ok(bridge.sessions.get('user:ou_test_owner'), 'session id stored after a good run');
  assert.equal(bridge.ledger.jobs()[0].state, 'done');
});

test('silent hang: watchdog stops it and the chat is told plainly', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'silent-hang');
  await bridge.start();
  fake.inject(dm('om_2', 'do something'));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.match(fake.sent[0].text, /No activity for 1 second, stopped\./);
  assert.equal(fake.lastCard().title, 'Stopped');
  assert.equal(bridge.ledger.jobs()[0].state, 'stopped');
  assert.equal(bridge.sessions.get('user:ou_test_owner'), undefined);
});

test('tool-open hang: not killed by the watchdog, only by the hard cap', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'tool-open-hang', { limits: { IDLE_MS: 800, HARD_CAP_MS: 3000 } });
  await bridge.start();
  const started = Date.now();
  fake.inject(dm('om_3', 'long job'));
  await fake.waitFor(() => fake.sent.length === 1, 8000);
  assert.ok(Date.now() - started >= 3000);
  assert.match(fake.sent[0].text, /hard cap/);
});

for (const mode of ['cage-extra-tool', 'cage-bypass']) {
  test(`cage breach (${mode}): refused, user told, no session stored`, async () => {
    const dirs = tempDirs();
    const { bridge, fake, log } = makeBridge(dirs, mode);
    await bridge.start();
    fake.inject(dm(`om_${mode}`, 'hello'));
    await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
    assert.match(fake.sent[0].text, /CAGE BREACH/);
    assert.ok(log.has('CAGE BREACH'));
    assert.equal(fake.lastCard().title, 'Refused');
    assert.deepEqual(fake.lastCard().buttons, []);
    assert.equal(bridge.sessions.get('user:ou_test_owner'), undefined);
    assert.equal(bridge.ledger.jobs()[0].state, 'failed');
  });
}

test('dead resume: retried fresh once, user told, the dead id is replaced', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'dead-resume');
  bridge.sessions.recordResult('user:ou_test_owner', { sessionId: 'dead-id', isError: false });
  await bridge.start();
  fake.inject(dm('om_4', 'continue'));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.match(fake.sent[0].text, /started fresh/);
  assert.equal(fakeRuns(dirs).length, 2);
  const now = bridge.sessions.get('user:ou_test_owner');
  assert.ok(now && now !== 'dead-id');
});

test('claude crashes after a Write: reported, not retried', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'crash-after-write');
  await bridge.start();
  fake.inject(dm('om_5', 'write it'));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.match(fake.sent[0].text, /ended without a result/);
  assert.equal(fakeRuns(dirs).length, 1);
});

test('bridge crashes mid-run: restart kills the orphan, does NOT rerun, tells the user', async () => {
  const dirs = tempDirs();
  const harness = spawn(process.execPath, [join(HERE, 'crash-harness.mjs'), dirs.stateDir, dirs.workdir, dirs.fakeLog, dirs.pidFile],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const claudePid = await new Promise((resolve, reject) => {
    let out = '';
    harness.stdout.on('data', (c) => { out += c; const m = out.match(/RUNNING (\d+)/); if (m) resolve(Number(m[1])); });
    harness.on('exit', () => reject(new Error('harness exited early')));
  });
  harness.kill('SIGKILL');                                    // a real crash: no cleanup runs
  await new Promise((r) => harness.once('close', r));
  assert.ok(isAlive(claudePid), 'the detached claude outlived the crashed bridge');

  const { bridge, fake } = makeBridge(dirs, 'normal');
  try {
    await bridge.start();
    assert.ok(await waitUntil(() => !isAlive(claudePid), 2000), 'orphaned claude group killed on startup');
    await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
    assert.match(fake.sent[0].text, /did not rerun/);
    assert.equal(fakeRuns(dirs).length, 1, 'claude was started exactly once');
    assert.equal(bridge.ledger.jobs()[0].state, 'interrupted');
  } finally {
    killQuietly(claudePid, true);
  }
});

test('bridge crashes after the result, before the reply is confirmed: user told, claude not rerun', async () => {
  const dirs = tempDirs();
  const harness = spawn(process.execPath,
    [join(HERE, 'crash-harness.mjs'), dirs.stateDir, dirs.workdir, dirs.fakeLog, dirs.pidFile, 'before-reply'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    let out = '';
    harness.stdout.on('data', (c) => { out += c; if (out.includes('REPLYING')) resolve(); });
    harness.on('exit', () => reject(new Error('harness exited early')));
  });
  harness.kill('SIGKILL');
  await new Promise((r) => harness.once('close', r));

  const { bridge, fake } = makeBridge(dirs, 'normal');
  await bridge.start();
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.match(fake.sent[0].text, /may not have reached you\. I did not rerun it; please ask again/);
  assert.equal(fakeRuns(dirs).length, 1, 'claude was started exactly once');
  const job = bridge.ledger.jobs()[0];
  assert.equal(job.state, 'interrupted');
  assert.equal(job.interruptedWhile, 'replying');
  assert.equal(job.outcome, 'done', 'the ledger still records how the run itself ended');
});

test('a job is marked done only after its reply is confirmed sent', async () => {
  const dirs = tempDirs();
  const { bridge, fake, log } = makeBridge(dirs, 'normal', { limits: { SEND_RETRIES: 0 } });
  const send = fake.platform.sendMessage;
  let states = [];
  fake.platform.sendMessage = async (target, text, opts) => {
    states.push(bridge.ledger.jobs()[0]?.state);
    return send(target, text, opts);
  };
  await bridge.start();
  fake.inject(dm('om_order', 'hello'));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  await bridge.whenIdle();
  assert.deepEqual(states, ['replying'], 'while the reply is on its way the job is replying, not done');
  const jobId = bridge.ledger.jobs()[0].id;
  assert.ok(log.lines.some((l) => new RegExp(`^job ${jobId} done in \\d+s; reply sent$`).test(l)), log.lines.join('\n'));
  assert.equal(bridge.ledger.jobs()[0].state, 'done');
  assert.equal(bridge.ledger.jobs()[0].replyDelivered, true);
});

test('a reply that cannot be sent: logged as NOT confirmed, final state kept', async () => {
  const dirs = tempDirs();
  const { bridge, fake, log } = makeBridge(dirs, 'normal', { limits: { SEND_RETRIES: 0 } });
  fake.platform.sendMessage = async () => { throw new Error('platform down'); };
  await bridge.start();
  fake.inject(dm('om_unsent', 'hello'));
  assert.ok(await waitUntil(() => log.lines.some((l) => /reply NOT confirmed sent$/.test(l)), 5000), log.lines.join('\n'));
  await bridge.whenIdle();
  const job = bridge.ledger.jobs()[0];
  assert.equal(job.state, 'done');
  assert.equal(job.replyDelivered, false);
  assert.ok(log.lines.some((l) => new RegExp(`^job ${job.id} done in \\d+s; reply NOT confirmed sent$`).test(l)));
});

test('stop button mid-run: a stranger tap is ignored, the owner tap kills the group', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'tool-open-hang', { limits: { HARD_CAP_MS: 60_000 } });
  await bridge.start();
  fake.inject(dm('om_6', 'long job'));
  assert.ok(await waitUntil(() => grandchildren(dirs).inGroup, 3000));
  const { inGroup } = grandchildren(dirs);
  const job = bridge.currentJob;

  fake.tap({ eventId: 'tap_1', operatorId: STRANGER, value: { kind: 'stop', job: job.id } });
  await sleep(200);
  assert.equal(fake.sent.length, 0, 'still running after a stranger tapped Stop');

  fake.tap({ eventId: 'tap_2', operatorId: ME, value: { kind: 'stop', job: job.id } });
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.equal(fake.sent[0].text, 'Stopped.');
  assert.ok(await waitUntil(() => !isAlive(inGroup), 2000), 'the whole group died');
  assert.deepEqual(fake.lastCard().buttons, []);
  assert.equal(bridge.ledger.jobs()[0].state, 'stopped');
});

test('duplicate message id is ignored, even after a restart', async () => {
  const dirs = tempDirs();
  const a = makeBridge(dirs, 'normal');
  await a.bridge.start();
  a.fake.inject(dm('om_dup', 'once only'));
  await a.fake.waitFor(() => a.fake.sent.length === 1);
  await a.bridge.shutdown();

  const b = makeBridge(dirs, 'normal');
  await b.bridge.start();
  b.fake.inject(dm('om_dup', 'once only'));
  await sleep(300);
  await b.bridge.whenIdle();
  assert.equal(fakeRuns(dirs).length, 1);
  assert.equal(b.fake.sent.length, 0);
  assert.ok(b.log.has('duplicate om_dup'));
});

test('sender not on the allowlist is ignored silently', async () => {
  const dirs = tempDirs();
  const { bridge, fake, log } = makeBridge(dirs, 'normal');
  await bridge.start();
  fake.inject(dm('om_7', 'let me in', STRANGER));
  await sleep(300);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.cards.size, 0);
  assert.equal(fakeRuns(dirs).length, 0);
  assert.ok(log.has('not on the allowlist'));
});

test('groups: ignored without an @-mention of the bot, answered with one', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'normal', { botId: BOT });
  await bridge.start();
  const group = { userId: ME, chatId: 'oc_test_group', chatType: 'group', text: 'hi' };
  fake.inject({ ...group, eventId: 'om_g1', mentions: [] });
  fake.inject({ ...group, eventId: 'om_g2', mentions: [{ id: 'ou_test_someone_else' }] });
  await sleep(300);
  assert.equal(fakeRuns(dirs).length, 0);

  fake.inject({ ...group, eventId: 'om_g3', mentions: [{ id: BOT }] });
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.ok(bridge.sessions.get('chat:oc_test_group'), 'group session is keyed by chat');
});

test('/new clears the session without calling claude; /restart is handled before claude', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'normal');
  bridge.sessions.recordResult('user:ou_test_owner', { sessionId: 'old', isError: false });
  await bridge.start();
  fake.inject(dm('om_8', '/new'));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.equal(fake.sent[0].text, 'Started fresh.');
  assert.equal(bridge.sessions.get('user:ou_test_owner'), undefined);

  fake.inject(dm('om_9', '/restart'));
  await fake.waitFor(() => fake.sent.length === 2);
  assert.equal(fake.sent[1].text, 'Restarting.');
  assert.equal(fakeRuns(dirs).length, 0);
});

test('limits: queued message is acknowledged; long message refused; failed send retried once', async () => {
  const dirs = tempDirs();
  const { bridge, fake } = makeBridge(dirs, 'normal', { limits: { MAX_MESSAGE_CHARS: 50 } });
  await bridge.start();
  fake.inject(dm('om_10', 'x'.repeat(51)));
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();                                    // the final state is written after the send
  assert.match(fake.sent[0].text, /limit is 50/);

  fake.failNext.send = 1;                                     // the first send attempt fails
  fake.inject(dm('om_11', 'first'));
  fake.inject(dm('om_12', 'second'));
  await fake.waitFor(() => replies(fake).filter((t) => t.startsWith('ok:')).length === 2, 8000);
  assert.ok(replies(fake).some((t) => /1 task ahead of yours/.test(t)), 'the waiting message was acknowledged');
  assert.equal(new Set(fake.sent.map((s) => s.idempotencyKey)).size, fake.sent.length, 'no send delivered twice');
});

test('ledger survives a reload and bounds its seen ids', () => {
  const dirs = tempDirs();
  const file = join(dirs.stateDir, 'ledger.json');
  const l1 = openLedger(file, { maxSeen: 3 });
  ['a', 'b', 'c', 'd'].forEach((id) => l1.markSeen(id));
  l1.addJob({ id: 'j1', chatId: 'oc_x', preview: 'p' });
  l1.setState('j1', 'running');
  const l2 = openLedger(file, { maxSeen: 3 });
  assert.equal(l2.hasSeen('a'), false, 'oldest id dropped');
  assert.equal(l2.hasSeen('d'), true);
  const notices = l2.recoverAfterRestart();
  assert.equal(notices[0].state, 'interrupted');
  assert.equal(openLedger(file).getJob('j1').state, 'interrupted');
});
