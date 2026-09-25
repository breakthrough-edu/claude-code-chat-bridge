// The approval card, offline: fake platform, real files, taps through the real loop (so the
// sender allowlist and tap dedupe in loop.mjs are part of every tap test).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../loop.mjs';
import { createApproval, parseDraftText, fingerprint, renderApprovalCard, OUTBOX_DIRNAME } from '../approval.mjs';
import { createWriteOutside } from '../actions/write-outside.mjs';
import { createFakePlatform } from './fake-platform.mjs';
import { renderCard } from '../platform-lark.mjs';
import { FAKE_CLAUDE, FAST_LIMITS, ME, STRANGER, tempDirs, fakeEnv, collectLog } from './helpers.mjs';

const CHAT = 'oc_test_dm';
const FAST_APPROVAL = { RETRY_BACKOFF_MS: 5, SEND_TIMEOUT_MS: 2000 };
const running = [];
afterEach(async () => {
  for (const b of running.splice(0)) await b.shutdown();
});

// A bridge with the approval card wired in the way docs/approval-card.md describes.
// `fake` can be passed in to simulate a restart that keeps the same chat.
function setup({ dirs = tempDirs(), fake = createFakePlatform(), now, limits = {}, failWrites = 0 } = {}) {
  const log = collectLog();
  dirs.outside ||= mkdtempSync(join(dirs.root, 'outside-'));
  const real = createWriteOutside({ outsideDir: dirs.outside, workdir: dirs.workdir });
  const counts = { executed: 0, failNext: failWrites };
  // Same action, with a counter and a switch to make the next N executions fail.
  const action = {
    ...real,
    async execute(d) {
      counts.executed++;
      if (counts.failNext > 0) { counts.failNext--; throw new Error('simulated failure: disk full'); }
      return real.execute(d);
    },
  };
  const approval = createApproval({
    platform: fake.platform, stateDir: dirs.stateDir, workdir: dirs.workdir,
    actions: { [action.name]: action }, limits: { ...FAST_APPROVAL, ...limits }, log,
    ...(now ? { now } : {}),
  });
  const bridge = createBridge({
    platform: fake.platform, workdir: dirs.workdir, claudeBin: FAKE_CLAUDE, allowedUsers: [ME],
    stateDir: dirs.stateDir, limits: FAST_LIMITS, childEnv: fakeEnv(dirs, 'normal'),
    onRestart: () => {}, log,
    onOtherCardAction: (a) => approval.handleAction(a),
  });
  running.push(bridge);
  return { dirs, fake, approval, bridge, log, counts, real };
}

// What the model would leave behind: a draft file in <WORKDIR>/outbox/.
function modelWrites(dirs, name, text) {
  const outbox = join(dirs.workdir, OUTBOX_DIRNAME);
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, name), text);
}

const DRAFT = { action: 'write-outside', title: 'Meeting notes for Friday', content: '# Notes\n\n- agenda item one\n- agenda item two\n' };
const draftJson = (over = {}) => `${JSON.stringify({ ...DRAFT, ...over }, null, 2)}\n`;

// Propose one draft through the outbox, the way a real run would, and return its card.
async function proposeOne(ctx, text = draftJson()) {
  modelWrites(ctx.dirs, 'draft.json', text);
  const res = await ctx.approval.collectOutbox({ chatId: CHAT, jobId: 'job-test' });
  assert.equal(res.proposed.length, 1, `expected one card, got ${JSON.stringify(res)}`);
  const d = ctx.approval.get(res.proposed[0]);
  return { d, card: ctx.fake.cards.get(d.cardId) };
}

function standaloneActions() {
  const dirs = tempDirs();
  const real = createWriteOutside({ outsideDir: join(dirs.root, 'outside'), workdir: dirs.workdir });
  return { [real.name]: real };
}

// loop.mjs hands a tap to the approval handler on the next microtask, so yield once
// before waiting for the taps in flight to finish.
async function settle(ctx) {
  await new Promise((r) => setImmediate(r));
  await ctx.approval.settled();
}

const lastOf = (card) => card.history[card.history.length - 1];
const buttonValue = (card, kind) => lastOf(card).buttons.find((b) => b.value.kind === kind).value;
const outsideFiles = (dirs) => readdirSync(dirs.outside);

test('approve: the pinned content is written, read back, and the card is repainted spent', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);

  const first = card.history[0];
  assert.match(first.markdown, /Not yet written/);
  assert.ok(first.markdown.includes(d.target), 'card shows the full target path');
  assert.ok(first.markdown.includes(DRAFT.content), 'card shows the exact content');
  assert.match(first.markdown, /Current:\*\* no file at this path/);
  assert.deepEqual(first.buttons.map((b) => b.text), ['Approve', 'Reject']);
  assert.deepEqual(first.buttons[0].value, { kind: 'approve', draft: d.id, fp: d.fingerprint });
  assert.equal(outsideFiles(ctx.dirs).length, 0, 'nothing written before the tap');
  assert.deepEqual(readdirSync(join(ctx.dirs.workdir, OUTBOX_DIRNAME)), [], 'outbox emptied');

  ctx.fake.tap({ eventId: 'tap_a1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(ctx);

  assert.equal(readFileSync(d.target, 'utf8'), DRAFT.content);
  assert.deepEqual(outsideFiles(ctx.dirs), [`${d.id}.md`], 'one file, named by the draft id');
  const spent = lastOf(card);
  assert.equal(spent.title, 'Done');
  assert.deepEqual(spent.buttons, [], 'spent card has no buttons');
  assert.match(spent.markdown, /read back/);
  const stored = ctx.approval.get(d.id);
  assert.equal(stored.state, 'done');
  assert.equal(stored.result.status, 'written');
});

test('double tap: the second tap is a no-op and the file is written once', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  const value = buttonValue(card, 'approve');

  ctx.fake.tap({ eventId: 'tap_d1', operatorId: ME, value });
  ctx.fake.tap({ eventId: 'tap_d2', operatorId: ME, value });   // a different tap, same button
  ctx.fake.tap({ eventId: 'tap_d1', operatorId: ME, value });   // a redelivery of the first
  await settle(ctx);

  assert.equal(ctx.counts.executed, 1, 'the action ran exactly once');
  assert.deepEqual(outsideFiles(ctx.dirs), [`${d.id}.md`]);
  assert.equal(ctx.approval.get(d.id).state, 'done');
  assert.ok(ctx.log.has(`${d.id} is claimed; tap ignored`) || ctx.log.has(`${d.id} is done; tap ignored`));
});

test('tap after expiry: refused, nothing written, card closed', async () => {
  let clock = Date.now();
  const ctx = setup({ now: () => clock, limits: { TTL_MS: 60_000 } });
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  clock += 61_000;

  ctx.fake.tap({ eventId: 'tap_e1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(ctx);

  assert.equal(ctx.counts.executed, 0);
  assert.equal(outsideFiles(ctx.dirs).length, 0);
  assert.equal(ctx.approval.get(d.id).state, 'expired');
  assert.equal(lastOf(card).title, 'Expired');
  assert.deepEqual(lastOf(card).buttons, []);
});

test('wrong fingerprint: refused, nothing written, the card keeps its buttons, the user is told', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  const forged = { ...buttonValue(card, 'approve'), fp: fingerprint({ ...d, content: 'something else' }) };

  ctx.fake.tap({ eventId: 'tap_f1', operatorId: ME, value: forged });
  await settle(ctx);

  assert.equal(ctx.counts.executed, 0);
  assert.equal(outsideFiles(ctx.dirs).length, 0);
  assert.equal(ctx.approval.get(d.id).state, 'pending');
  assert.equal(lastOf(card).buttons.length, 2);
  assert.match(ctx.fake.sent.at(-1).text, /did not match its pinned content/);
});

test('action failure: the draft goes back to pending and the card still has its buttons; a retry succeeds', async () => {
  const ctx = setup({ failWrites: 1 });
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);

  ctx.fake.tap({ eventId: 'tap_x1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(ctx);
  let stored = ctx.approval.get(d.id);
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attempts, 1);
  assert.match(lastOf(card).markdown, /simulated failure: disk full/);
  assert.match(lastOf(card).markdown, /Not yet written/);
  assert.deepEqual(lastOf(card).buttons.map((b) => b.text), ['Approve', 'Reject'], 'the card is not dead');
  assert.equal(outsideFiles(ctx.dirs).length, 0);

  ctx.fake.tap({ eventId: 'tap_x2', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(ctx);
  stored = ctx.approval.get(d.id);
  assert.equal(stored.state, 'done');
  assert.equal(readFileSync(d.target, 'utf8'), DRAFT.content);
});

test('repeated failures stop at the attempt limit as failed, with the buttons removed', async () => {
  const ctx = setup({ failWrites: 5, limits: { MAX_ATTEMPTS: 2 } });
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  for (const id of ['tap_m1', 'tap_m2', 'tap_m3']) {
    ctx.fake.tap({ eventId: id, operatorId: ME, value: buttonValue(card, 'approve') });
    await settle(ctx);
    if (!lastOf(card).buttons.length) break;
  }
  assert.equal(ctx.counts.executed, 2);
  assert.equal(ctx.approval.get(d.id).state, 'failed');
  assert.equal(lastOf(card).title, 'Failed');
  assert.deepEqual(lastOf(card).buttons, []);
});

test('same draft id with different content already on disk: an error, never an overwrite', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  writeFileSync(d.target, 'someone else wrote this\n');

  ctx.fake.tap({ eventId: 'tap_c1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(ctx);

  assert.equal(readFileSync(d.target, 'utf8'), 'someone else wrote this\n', 'not overwritten');
  assert.equal(ctx.approval.get(d.id).state, 'pending');
  assert.match(lastOf(card).markdown, /different file already exists/);
});

test('reject: nothing written, card closed', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  const approveValue = buttonValue(card, 'approve');

  ctx.fake.tap({ eventId: 'tap_r1', operatorId: ME, value: buttonValue(card, 'reject') });
  await settle(ctx);
  ctx.fake.tap({ eventId: 'tap_r2', operatorId: ME, value: approveValue });   // late tap on a stale copy of the card
  await settle(ctx);

  assert.equal(ctx.counts.executed, 0);
  assert.equal(outsideFiles(ctx.dirs).length, 0);
  assert.equal(ctx.approval.get(d.id).state, 'rejected');
  assert.equal(lastOf(card).title, 'Rejected');
  assert.deepEqual(lastOf(card).buttons, []);
});

test('a tap from someone not on the allowlist never reaches the card', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const { d, card } = await proposeOne(ctx);
  ctx.fake.tap({ eventId: 'tap_s1', operatorId: STRANGER, value: buttonValue(card, 'approve') });
  await settle(ctx);
  assert.equal(ctx.counts.executed, 0);
  assert.equal(ctx.approval.get(d.id).state, 'pending');
});

test('restart between propose and tap: the draft survives on disk and the tap still works', async () => {
  const first = setup();
  await first.bridge.start();
  const { d, card } = await proposeOne(first);
  await first.bridge.shutdown();

  // A new process: new bridge, new approval store object, same state folder and same chat.
  const second = setup({ dirs: first.dirs, fake: first.fake });
  await second.bridge.start();
  assert.deepEqual(await second.approval.recover(), [], 'nothing to recover for a plain pending draft');
  first.fake.tap({ eventId: 'tap_rs1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(second);

  assert.equal(readFileSync(d.target, 'utf8'), DRAFT.content);
  assert.equal(second.approval.get(d.id).state, 'done');
  assert.deepEqual(lastOf(card).buttons, []);
});

test('crash mid-action: a claimed draft returns to pending on restart; if the file was already written, approving again does not write twice', async () => {
  const first = setup();
  await first.bridge.start();
  const { d, card } = await proposeOne(first);
  await first.bridge.shutdown();

  // Simulate the crash: the file landed, the store still says claimed.
  await first.real.execute({ id: d.id, target: d.target, content: d.content });
  const store = JSON.parse(readFileSync(first.approval.file, 'utf8'));
  store.drafts.find((x) => x.id === d.id).state = 'claimed';
  writeFileSync(first.approval.file, JSON.stringify(store));

  const second = setup({ dirs: first.dirs, fake: first.fake });
  await second.bridge.start();
  assert.deepEqual(await second.approval.recover(), [{ id: d.id, state: 'pending' }]);
  assert.equal(lastOf(card).buttons.length, 2, 'the card came back to life');
  assert.match(lastOf(card).markdown, /restarted while this was running/);

  first.fake.tap({ eventId: 'tap_cr1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(second);
  const stored = second.approval.get(d.id);
  assert.equal(stored.state, 'done');
  assert.equal(stored.result.status, 'already-done');
  assert.deepEqual(outsideFiles(first.dirs), [`${d.id}.md`]);
  assert.match(lastOf(card).markdown, /not written again/);
});

test('malformed draft file: refused with a clear message, kept as evidence, no card', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  modelWrites(ctx.dirs, 'bad.json', '{"action": "write-outside", "title": "x", "content": "y", "path": "/etc/hosts"}\n');
  const res = await ctx.approval.collectOutbox({ chatId: CHAT, jobId: 'job-bad' });

  assert.equal(res.proposed.length, 0);
  assert.match(res.rejected[0].error, /unknown key "path"/);
  assert.equal(ctx.fake.cards.size, 0);
  assert.match(ctx.fake.sent.at(-1).text, /did not card the draft outbox\/bad\.json: unknown key "path"/);
  assert.deepEqual(readdirSync(join(ctx.dirs.workdir, OUTBOX_DIRNAME)), [], 'removed from the outbox');
  assert.equal(readdirSync(join(ctx.dirs.stateDir, 'approvals', 'rejected')).length, 1, 'raw output kept');
});

test('a draft from a run that did not finish is not carded', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  modelWrites(ctx.dirs, 'draft.json', draftJson());
  const res = await ctx.approval.collectOutbox({ chatId: CHAT, jobId: 'job-stopped', runOk: false });
  assert.equal(res.proposed.length, 0);
  assert.match(res.rejected[0].error, /did not finish/);
  assert.equal(ctx.fake.cards.size, 0);
});

test('parser: accepts what a real model writes (fences, trailing newline, BOM, CRLF, key order)', () => {
  const actions = standaloneActions();
  const body = JSON.stringify(DRAFT);
  const variants = {
    plain: `${body}\n`,
    fencedJson: `\`\`\`json\n${JSON.stringify(DRAFT, null, 2)}\n\`\`\`\n`,
    fencedBare: `\n\n\`\`\`\n${body}\n\`\`\`\n\n`,
    bom: `﻿${body}`,
    crlf: JSON.stringify(DRAFT, null, 2).replace(/\n/g, '\r\n'),
    reordered: JSON.stringify({ content: DRAFT.content, title: DRAFT.title, action: DRAFT.action }),
  };
  for (const [name, text] of Object.entries(variants)) {
    const r = parseDraftText(text, actions);
    assert.ok(r.ok, `${name}: ${r.error}`);
    assert.deepEqual(r.value, DRAFT, name);
  }
});

// Two drafts in the exact shape a model writes into outbox/ from the CLAUDE.md block in
// docs/approval-card.md: a trailing newline on one, none on the other. Both must parse.
// A model may put a file name in the title; the title is only a label, and the file is
// named by the draft id.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('parser: accepts the fixture drafts in bridge/test/fixtures/', () => {
  const actions = standaloneActions();
  for (const name of ['real-draft-poem.json', 'real-draft-shopping-list.json']) {
    const raw = readFileSync(join(FIXTURES, name));
    const r = parseDraftText(raw, actions);
    assert.ok(r.ok, `${name}: ${r.error}`);
    assert.equal(r.value.action, 'write-outside', name);
    assert.equal(r.value.content, JSON.parse(raw.toString('utf8')).content, `${name}: content pinned unchanged`);
  }
});

test('parser: refuses everything else with a message that says what is wrong', () => {
  const actions = standaloneActions();
  const cases = [
    ['', /empty/],
    ['not json at all', /not valid JSON/],
    [`Here is the draft:\n\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\``, /text outside the code fence/],
    [`\`\`\`json\n${JSON.stringify(DRAFT)}`, /text outside the code fence|does not close/],
    [`\`\`\`yaml\n${JSON.stringify(DRAFT)}\n\`\`\``, /must be json/],
    [JSON.stringify([DRAFT]), /one object/],
    [JSON.stringify({ ...DRAFT, action: 'delete-everything' }), /"action" must be one of: write-outside/],
    [JSON.stringify({ ...DRAFT, file: 'x.md' }), /unknown key "file"/],
    [JSON.stringify({ action: 'write-outside', title: 't' }), /"content" must be a string/],
    [JSON.stringify({ ...DRAFT, content: '   ' }), /"content" is empty/],
    [JSON.stringify({ ...DRAFT, content: 'x'.repeat(3001) }), /limit is 3000/],
    [JSON.stringify({ ...DRAFT, content: 'pay ‮evil' }), /invisible characters/],
    [JSON.stringify({ ...DRAFT, title: 'two\nlines' }), /one line/],
    [`${JSON.stringify(DRAFT)}\n${JSON.stringify(DRAFT)}`, /not valid JSON/],
  ];
  for (const [text, want] of cases) {
    const r = parseDraftText(text, actions);
    assert.equal(r.ok, false, `should refuse: ${text.slice(0, 60)}`);
    assert.match(r.error, want, text.slice(0, 60));
  }
});

test('image syntax is refused, because the Lark card would show it rewritten', () => {
  const actions = standaloneActions();
  const cases = [
    ['content', 'see ![the chart](https://example.com/chart.png) here'],
    ['content', 'ref style ![chart][c]\n\n[c]: https://example.com/chart.png'],
    ['content', '<IMG src="https://example.com/x.png">'],
    ['title', 'Notes with ![icon](https://example.com/i.png)'],
  ];
  for (const [key, value] of cases) {
    const r = parseDraftText(JSON.stringify({ ...DRAFT, [key]: value }), actions);
    assert.equal(r.ok, false, value);
    assert.match(r.error, new RegExp(`"${key}" contains image syntax.*describe the image or give the plain URL`), value);
  }
});

test('what the card shows is what gets written: plain URLs, links and fences survive the Lark renderer unchanged', async () => {
  const ctx = setup();
  await ctx.bridge.start();
  const content = [
    'Photo: https://example.com/pic.png',
    'A [normal link](https://example.com/page) and [a ref link][r].',
    '',
    '[r]: https://example.com/ref',
    'Inline `code` and a fence:',
    '```js',
    'const x = 1;',
    '```',
    'Bang then bracket split: ! [not an image]',
    '',
  ].join('\n');
  const { d, card } = await proposeOne(ctx, draftJson({ content }));

  // Render the stored card exactly as platform-lark.mjs would before sending it to Lark.
  const shown = renderCard(card.history[0]).body.elements[0].content;
  assert.ok(shown.includes(content), 'the rendered card body contains the content verbatim');
  assert.ok(shown.includes(d.target) && shown.includes(DRAFT.title));
  assert.equal(renderCard(renderApprovalCard({ ...d, describe: 'x', maxAttempts: 3 })).body.elements[0].content,
    renderApprovalCard({ ...d, describe: 'x', maxAttempts: 3 }).markdown, 'the renderer changed nothing on the card');

  ctx.fake.tap({ eventId: 'tap_u1', operatorId: ME, value: buttonValue(card, 'approve') });
  await settle(ctx);
  assert.equal(readFileSync(d.target, 'utf8'), content);
});

test('the outside folder may not overlap the working directory', () => {
  const dirs = tempDirs();
  assert.throws(() => createWriteOutside({ outsideDir: join(dirs.workdir, 'out'), workdir: dirs.workdir }), /overlap/);
  assert.throws(() => createWriteOutside({ outsideDir: dirs.root, workdir: dirs.workdir }), /overlap/);
  assert.throws(() => createWriteOutside({ outsideDir: 'relative/path', workdir: dirs.workdir }), /absolute/);
  assert.ok(existsSync(dirs.workdir));
});
