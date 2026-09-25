// platform-lark.mjs against a fake lark-cli: the argv it sends, stdin held open, message
// normalisation, card create/update with an increasing sequence. No Lark app is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLarkPlatform, renderCard, parseValue, neutraliseImageLinks, findErrorReport, describeFatal } from '../platform-lark.mjs';
import { assertPlatform } from '../platform.mjs';
import { tempDirs, waitUntil } from './helpers.mjs';

const FAKE_LARK = join(dirname(fileURLToPath(import.meta.url)), 'fake-lark-cli.mjs');

function setup() {
  const dirs = tempDirs();
  const logFile = join(dirs.root, 'lark.log');
  process.env.FAKE_LARK_LOG = logFile;                  // inherited by the spawned fake
  const platform = createLarkPlatform({ larkCli: FAKE_LARK, profile: 'test-profile', log: () => {} });
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { platform, calls };
}

test('implements the whole interface', () => {
  assertPlatform(createLarkPlatform({ larkCli: FAKE_LARK }));
});

test('consumer: --as bot and --profile passed, stdin kept open, message normalised', async () => {
  const { platform, calls } = setup();
  const got = [];
  const states = [];
  const sub = platform.consumeMessages((m) => got.push(m), { onState: (s) => states.push(s) });
  assert.ok(await waitUntil(() => got.length === 1, 3000));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(states, ['listening'], 'the consumer did not exit: its stdin is still open');
  sub.close();

  const argv = calls().find((a) => a[0] === 'event');
  assert.deepEqual(argv.slice(0, 3), ['event', 'consume', 'im.message.receive_v1']);
  assert.ok(argv.includes('--as') && argv[argv.indexOf('--as') + 1] === 'bot');
  assert.equal(argv[argv.indexOf('--profile') + 1], 'test-profile');

  assert.equal(got[0].eventId, 'om_test_1', 'dedupe key is message_id, not event_id');
  assert.equal(got[0].text, 'summarise my notes', 'mention placeholder stripped');
  assert.equal(got[0].mentions[0].id, 'ou_test_bot');
});

test('card tap: action value parsed from its JSON string', async () => {
  const { platform } = setup();
  const taps = [];
  const sub = platform.onCardAction((a) => taps.push(a));
  assert.ok(await waitUntil(() => taps.length === 1, 3000));
  sub.close();
  assert.deepEqual(taps[0].value, { kind: 'stop', job: 'job-1' });
  assert.equal(taps[0].operatorId, 'ou_test_owner');
});

test('sendCard then updateCard: card entity, interactive message, sequence increases', async () => {
  const { platform, calls } = setup();
  const { cardId, messageId } = await platform.sendCard({ chatId: 'oc_test_dm' },
    { title: 'Working', markdown: 'x', buttons: [{ text: 'Stop', value: { kind: 'stop', job: 'j' } }] },
    { idempotencyKey: 'k'.repeat(80) });
  assert.equal(cardId, 'card_test_1');
  assert.equal(messageId, 'om_test_sent');
  await platform.updateCard(cardId, { title: 'Working', markdown: 'y' });
  await platform.updateCard(cardId, { title: 'Done', markdown: 'z', buttons: [] });

  const c = calls();
  const send = c.find((a) => a[1] === '+messages-send');
  assert.equal(send[send.indexOf('--msg-type') + 1], 'interactive');
  const key = send[send.indexOf('--idempotency-key') + 1];
  assert.ok(key.length <= 50, 'long idempotency keys are hashed down to the platform limit');
  const puts = c.filter((a) => a[1] === 'PUT').map((a) => JSON.parse(a[a.indexOf('--data') + 1]));
  assert.deepEqual(puts.map((p) => p.sequence), [1, 2]);
  const finished = JSON.parse(puts[1].card.data);
  assert.equal(finished.body.elements.filter((e) => e.tag === 'button').length, 0, 'finished card has no button');
});

test('renderCard and parseValue', () => {
  const card = renderCard({ title: 't', markdown: 'm', buttons: [{ text: 'Stop', type: 'danger', value: { kind: 'stop' } }] });
  assert.equal(card.schema, '2.0');
  assert.deepEqual(card.body.elements[1].behaviors[0], { type: 'callback', value: { kind: 'stop' } });
  assert.deepEqual(parseValue('{"a":1}'), { a: 1 });
  assert.deepEqual(parseValue({ a: 1 }), { a: 1 });
  assert.deepEqual(parseValue('not json'), {});
  assert.deepEqual(parseValue(undefined), {});
  assert.deepEqual(parseValue('"a string"'), {});
});

// lark-cli's --markdown fetches image URLs it finds. Model output must never reach it with one.
test('image links: inline image neutralised, URL kept as inline code', () => {
  assert.equal(neutraliseImageLinks('a ![cat](https://x.test/c.png "t") b'), 'a [image: cat] `https://x.test/c.png` b');
  assert.equal(neutraliseImageLinks('![wiki](https://x.test/a_(b).png)'), '[image: wiki] `https://x.test/a_(b).png`');
  assert.equal(neutraliseImageLinks('![]()'), '[image: no description]');
});

test('image links: reference-style, collapsed and shortcut images neutralised', () => {
  assert.equal(neutraliseImageLinks('![a][1]\n\n[1]: https://x.test/a.png'),
    '[image: a] `https://x.test/a.png`\n\n[1]: https://x.test/a.png');
  assert.match(neutraliseImageLinks('![Logo][]\n[logo]: <https://x.test/l.png>'), /^\[image: Logo\] `https:\/\/x\.test\/l\.png`/);
  assert.match(neutraliseImageLinks('![logo]\n[logo]: https://x.test/l.png'), /^\[image: logo\] `https:\/\/x\.test\/l\.png`/);
});

test('image links: HTML img neutralised, whatever the case', () => {
  assert.equal(neutraliseImageLinks('<IMG alt="pic" SRC="https://x.test/p.png">'), '[image: pic] `https://x.test/p.png`');
  assert.equal(neutraliseImageLinks("<img src='https://x.test/q.png'/>"), '[image: no description] `https://x.test/q.png`');
});

test('image links: ordinary links and their definitions untouched', () => {
  const t = 'see [docs](https://x.test/d) and [ref][1]\n\n[1]: https://x.test/r';
  assert.equal(neutraliseImageLinks(t), t);
  assert.equal(neutraliseImageLinks('[![badge](https://x.test/b.svg)](https://x.test/home)'),
    '[[image: badge] `https://x.test/b.svg`](https://x.test/home)');
});

test('image links: neutralised inside code fences too (safety over verbatim code)', () => {
  assert.equal(neutraliseImageLinks('```\n![x](https://x.test/f.png)\n```'), '```\n[image: x] `https://x.test/f.png`\n```');
});

test('image links: anything the patterns miss can no longer parse as an image', () => {
  const out = neutraliseImageLinks('![a](<https://x.test/a b.png>) ![b](https://x.test/b.png "unclosed');
  assert.ok(!out.includes('!['), out);
  assert.ok(!/<img/i.test(neutraliseImageLinks('<img')));
});

test('image links: the send and card paths both neutralise', async () => {
  const { platform, calls } = setup();
  await platform.sendMessage({ chatId: 'oc_test_dm' }, 'here ![x](https://x.test/leak.png)');
  const send = calls().find((a) => a[1] === '+messages-send');
  assert.equal(send[send.indexOf('--markdown') + 1], 'here [image: x] `https://x.test/leak.png`');
  const card = renderCard({ title: 't', markdown: '![y](https://x.test/leak2.png)' });
  assert.equal(card.body.elements[0].content, '[image: y] `https://x.test/leak2.png`');
});

// lark-cli prints its error report as pretty-printed JSON on stderr; the bridge logs each
// stderr line after a `[<event key>] ` prefix.
const PRETTY_ERROR = `[im.message.receive_v1] {
  "ok": false,
  "identity": "bot",
  "error": {
    "type": "config",
    "subtype": "invalid_client",
    "code": 20069,
    "message": "The specified app is not enabled.",
    "hint": "run \`lark-cli config init\` to set valid app_id and app_secret"
  },
  "_notice": { "text": "a } brace and a { brace, and an escaped \\" quote" }
}
`;

test('findErrorReport: pretty-printed multi-line report after a prefix, braces inside strings', () => {
  const e = findErrorReport(PRETTY_ERROR);
  assert.equal(e.code, 20069);
  assert.equal(e.type, 'config');
  assert.equal(e.message, 'The specified app is not enabled.');
  assert.match(e.hint, /lark-cli config init/);
});

test('findErrorReport: single-line report, the last one wins, nothing found is null', () => {
  const one = '{"ok":false,"error":{"type":"auth","message":"first"}}';
  const two = '{"ok":false,"error":{"type":"config","message":"second"}}';
  assert.equal(findErrorReport(`noise\n${one}\nmore\n${two}\n`).message, 'second');
  assert.equal(findErrorReport('{"ok":true,"data":{}}'), null);
  assert.equal(findErrorReport('[event] ready event_key=x\nplain text'), null);
  assert.equal(findErrorReport('{"ok": false, "error": {"message": "cut off'), null);
});

test('describeFatal: message, code and hint in one line', () => {
  const line = describeFatal('im.message.receive_v1', findErrorReport(PRETTY_ERROR), 3);
  assert.match(line, /The specified app is not enabled\. \(code 20069\)\. Hint: run `lark-cli config init`/);
  assert.match(describeFatal('k', null, 3), /lark-cli exited with code 3\./);
});

test('listening only after the ready line: a started consumer that never says ready is not listening', async () => {
  const { platform } = setup();
  process.env.FAKE_LARK_MODE = 'not-ready';
  const states = [];
  const sub = platform.consumeMessages(() => {}, { onState: (s) => states.push(s) });
  await new Promise((r) => setTimeout(r, 500));
  sub.close();
  delete process.env.FAKE_LARK_MODE;
  assert.deepEqual(states, [], 'started, but never reported listening');
});

test('a consumer failing on config never reports listening, and goes fatal with the full message', async () => {
  const { platform } = setup();
  process.env.FAKE_LARK_MODE = 'config-error';
  const states = [];
  let fatal = null;
  platform.consumeMessages(() => {}, { onState: (s) => states.push(s), onFatal: (m) => { fatal = m; } });
  const ok = await waitUntil(() => fatal, 10_000);
  delete process.env.FAKE_LARK_MODE;
  assert.ok(ok, 'fatal was reported');
  assert.ok(!states.includes('listening'), `states: ${states.join(',')}`);
  assert.match(fatal, /The specified app is not enabled\. \(code 20069\)\. Hint: run `lark-cli config init`/);
});
