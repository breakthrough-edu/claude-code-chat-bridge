// scripts/whoami.sh against the fake lark-cli. Run with /bin/bash, the old bash macOS
// ships, so the script is proved on the shell most readers have.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDirs, waitUntil, isAlive, killQuietly } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'whoami.sh');
const FAKE_LARK = join(HERE, 'fake-lark-cli.mjs');
const leftovers = [];
after(() => leftovers.forEach((p) => killQuietly(p)));

function whoami(profile, mode, extraEnv = {}) {
  const dirs = tempDirs();
  const signals = join(dirs.root, 'signals.log');
  const child = spawn('/bin/bash', [SCRIPT, profile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      LARK_CLI: FAKE_LARK,
      FAKE_LARK_MODE: mode,
      FAKE_LARK_SIGNALS: signals,
      FAKE_LARK_LOG: join(dirs.root, 'lark.log'),
      ...extraEnv,
    },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const done = new Promise((r) => child.on('close', (code) => r(code)));
  return { done, output: () => out, signals: () => (existsSync(signals) ? readFileSync(signals, 'utf8') : ''),
    larkCalls: () => readFileSync(join(dirs.root, 'lark.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('prints the sender id and chat type, then stops the consumer with SIGTERM', async () => {
  const w = whoami('whoami-test-ok', 'whoami');
  const code = await w.done;
  assert.equal(code, 0, w.output());
  assert.match(w.output(), /Listening\. Send the bot any direct message now\./);
  assert.match(w.output(), /sender_id: ou_test_owner/);
  assert.match(w.output(), /chat_type: p2p/);
  assert.match(w.output(), /chat_id: oc_test_dm/);
  assert.doesNotMatch(w.output(), /\bhi\b/, 'message content is never printed');
  assert.equal(w.signals(), 'SIGTERM\n', 'the consumer got SIGTERM, not SIGKILL');
  const argv = w.larkCalls()[0];
  assert.deepEqual(argv, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--profile', 'whoami-test-ok']);
});

test('refuses while a consumer for the same profile and event is running; other profiles are fine', async () => {
  const profile = 'whoami-test-busy';
  const other = spawn(process.execPath, [FAKE_LARK, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--profile', profile],
    { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, FAKE_LARK_MODE: 'quiet' } });
  leftovers.push(other.pid);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const w = whoami(profile, 'whoami');
    assert.equal(await w.done, 1);
    assert.match(w.output(), /refusing: a consumer for im\.message\.receive_v1 on profile whoami-test-busy is already running/);
    assert.ok(isAlive(other.pid), 'the running consumer was not touched');

    const w2 = whoami('whoami-test-free', 'whoami');
    assert.equal(await w2.done, 0, w2.output());
  } finally {
    killQuietly(other.pid);
  }
});

test('a disabled app: Lark\'s message, code and hint, exit 1', async () => {
  const w = whoami('whoami-test-cfg', 'config-error');
  assert.equal(await w.done, 1);
  assert.match(w.output(), /The specified app is not enabled\. \(code 20069\)\. Hint: run `lark-cli config init`/);
  assert.doesNotMatch(w.output(), /Listening/);
});

test('no message before the deadline: a clear message, exit 3, consumer stopped', async () => {
  const w = whoami('whoami-test-slow', 'quiet', { WHOAMI_TIMEOUT_S: '2' });
  assert.equal(await w.done, 3);
  assert.match(w.output(), /No message within 2 s/);
  assert.ok(await waitUntil(() => w.signals() === 'SIGTERM\n', 3000), 'the consumer got SIGTERM');
});
