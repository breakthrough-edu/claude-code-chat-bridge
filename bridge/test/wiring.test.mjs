// The loop and the approval card wired together the way bridge.mjs wires them:
// the model (fake claude) leaves a draft in outbox/, the loop hands it to approval.mjs after
// the reply, a card appears, and only the owner's tap makes the program write the file,
// once, into a folder outside the working directory.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { openLedger } from '../ledger.mjs';
import { join } from 'node:path';
import { createBridge } from '../loop.mjs';
import { createApproval } from '../approval.mjs';
import { createWriteOutside } from '../actions/write-outside.mjs';
import { createFakePlatform } from './fake-platform.mjs';
import { FAST_LIMITS, FAKE_CLAUDE, ME, STRANGER, tempDirs, fakeEnv, collectLog } from './helpers.mjs';

const running = [];
afterEach(async () => { for (const b of running.splice(0)) await b.shutdown(); });

async function wired(mode, extraEnv, dirs = tempDirs()) {
  const outsideDir = mkdtempSync(join(dirs.root, 'outside-'));   // a sibling, never inside the workdir
  const fake = createFakePlatform();
  const log = collectLog();
  const writeOutside = createWriteOutside({ outsideDir, workdir: dirs.workdir });
  const approval = createApproval({
    platform: fake.platform, stateDir: dirs.stateDir, workdir: dirs.workdir,
    actions: { [writeOutside.name]: writeOutside }, limits: { RETRY_BACKOFF_MS: 10 }, log,
  });
  await approval.recover();
  const bridge = createBridge({
    platform: fake.platform,
    workdir: dirs.workdir,
    claudeBin: FAKE_CLAUDE,
    allowedUsers: [ME],
    stateDir: dirs.stateDir,
    limits: FAST_LIMITS,
    childEnv: fakeEnv(dirs, mode, extraEnv),
    onRestart: () => {},
    onOtherCardAction: (a) => approval.handleAction(a),
    onJobDone: (job, { state }) => approval.collectOutbox({ chatId: job.chatId, jobId: job.id, runOk: state === 'done' }),
    log,
  });
  running.push(bridge);
  await bridge.start();
  return { dirs, outsideDir, fake, approval, bridge, log };
}

const approvalCard = (fake) => [...fake.cards.values()].find((c) => c.history[0].buttons?.some((b) => b.value.kind === 'approve'));
const approveValue = (card) => card.history[0].buttons.find((b) => b.value.kind === 'approve').value;

test('draft in outbox: card appears; a stranger tap does nothing; the owner tap writes the file once', async () => {
  const { dirs, outsideDir, fake, approval, bridge } = await wired('draft-outbox');
  fake.inject({ eventId: 'om_w1', userId: ME, chatId: 'oc_test_dm', text: 'draft the notes file' });
  await fake.waitFor(() => approvalCard(fake), 5000);
  await bridge.whenIdle();

  const card = approvalCard(fake);
  assert.match(card.history[0].markdown, /Not yet written/);
  assert.match(card.history[0].markdown, /- first item/, 'the card shows the content');
  assert.deepEqual(readdirSync(join(dirs.workdir, 'outbox')), [], 'the draft left the model folder');
  assert.deepEqual(readdirSync(outsideDir), [], 'nothing written before the tap');

  const value = approveValue(card);
  fake.tap({ eventId: 'tap_stranger', operatorId: STRANGER, value });
  await approval.settled();
  assert.deepEqual(readdirSync(outsideDir), [], 'a stranger tap wrote nothing');

  fake.tap({ eventId: 'tap_owner', operatorId: ME, value });
  await new Promise((r) => setTimeout(r, 20));
  await approval.settled();
  const files = readdirSync(outsideDir);
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(outsideDir, files[0]), 'utf8'), '# Notes\n\n- first item\n');
  assert.equal(card.history.at(-1).title, 'Done');
  assert.deepEqual(card.history.at(-1).buttons, [], 'spent card has no buttons');

  // A second tap on the same button (a new tap id, so the loop does not dedupe it) writes nothing new.
  fake.tap({ eventId: 'tap_owner_again', operatorId: ME, value });
  await new Promise((r) => setTimeout(r, 20));
  await approval.settled();
  assert.equal(readdirSync(outsideDir).length, 1);
});

test('a draft left by a run that did not finish is refused, never carded', async () => {
  const { dirs, outsideDir, fake, bridge } = await wired('draft-outbox', { FAKE_CLAUDE_DRAFT_CRASH: '1' });
  fake.inject({ eventId: 'om_w2', userId: ME, chatId: 'oc_test_dm', text: 'draft it' });
  await fake.waitFor(() => fake.sent.some((m) => /did not card the draft/.test(m.text)), 5000);
  await bridge.whenIdle();
  assert.match(fake.sent[0].text, /ended without a result/);
  assert.equal(approvalCard(fake), undefined, 'no approval card');
  assert.deepEqual(readdirSync(join(dirs.workdir, 'outbox')), [], 'the draft was moved out of the model folder');
  assert.deepEqual(readdirSync(outsideDir), [], 'nothing written');
});

test('after a crash, a draft left by the interrupted run is refused at startup, never carded', async () => {
  const dirs = tempDirs();
  // What a crash leaves behind: the ledger says running, and the model had written a draft.
  const ledger = openLedger(join(dirs.stateDir, 'ledger.json'));
  ledger.addJob({ id: 'job-crashed', chatId: 'oc_test_dm', preview: 'draft it' });
  ledger.setState('job-crashed', 'running');
  mkdirSync(join(dirs.workdir, 'outbox'));
  writeFileSync(join(dirs.workdir, 'outbox', 'draft.json'),
    JSON.stringify({ action: 'write-outside', title: 'Half done', content: 'part one\n' }));

  const { fake, outsideDir } = await wired('normal', {}, dirs);
  await fake.waitFor(() => fake.sent.some((m) => /did not card the draft/.test(m.text)), 5000);
  assert.match(fake.sent[0].text, /did not rerun/);
  assert.equal(approvalCard(fake), undefined);
  assert.deepEqual(readdirSync(join(dirs.workdir, 'outbox')), []);
  assert.deepEqual(readdirSync(outsideDir), []);
});

test('a card handler that rejects is logged, not a crash', async () => {
  const dirs = tempDirs();
  const fake = createFakePlatform();
  const log = collectLog();
  const bridge = createBridge({
    platform: fake.platform, workdir: dirs.workdir, claudeBin: FAKE_CLAUDE, allowedUsers: [ME],
    stateDir: dirs.stateDir, limits: FAST_LIMITS, childEnv: fakeEnv(dirs, 'normal'), onRestart: () => {}, log,
    onOtherCardAction: async () => { throw new Error('boom'); },
    onJobDone: async () => { throw new Error('bang'); },
  });
  running.push(bridge);
  await bridge.start();
  fake.tap({ eventId: 'tap_x', operatorId: ME, value: { kind: 'approve', draft: 'x', fp: 'y' } });
  fake.inject({ eventId: 'om_w4', userId: ME, chatId: 'oc_test_dm', text: 'hello' });
  await fake.waitFor(() => fake.sent.length === 1);
  await bridge.whenIdle();
  assert.ok(log.has('card action handler failed'));
  assert.ok(log.has('onJobDone failed'));
});
