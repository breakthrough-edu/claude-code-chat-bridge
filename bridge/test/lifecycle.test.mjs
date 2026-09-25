// The real entry point, bridge/bridge.mjs, run as its own process with fakes underneath
// (fake lark-cli, fake claude). This is how the process ends, which only a real process
// can show:
//   - a config error no restart can fix: FATAL logged, exit code 1;
//   - a listener that drops once: restarted, and the process stays up;
//   - listeners that keep dropping: the process stays up and says "down", never exits 0.
// Running the file as a child process is not importing it: nothing here starts a consumer
// inside the test runner.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CLAUDE, ME, tempDirs, waitUntil, isAlive, killQuietly } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'bridge.mjs');
const FAKE_LARK = join(HERE, 'fake-lark-cli.mjs');

const started = [];
after(() => started.forEach((p) => killQuietly(p.pid)));

function runBridge(larkMode) {
  const dirs = tempDirs();
  const counter = join(dirs.root, 'lark-counts');
  mkdirSync(counter);
  const child = spawn(process.execPath, [ENTRY], {
    cwd: dirs.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      BRIDGE_WORKDIR: dirs.workdir,
      CLAUDE_BIN: FAKE_CLAUDE,
      BRIDGE_ALLOWED_USERS: ME,
      BRIDGE_STATE_DIR: dirs.stateDir,
      LARK_CLI: FAKE_LARK,
      FAKE_LARK_MODE: larkMode,
      FAKE_LARK_COUNTER: counter,
    },
  });
  started.push(child);
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const heartbeat = () => {
    const f = join(dirs.stateDir, 'heartbeat.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  };
  return { child, exited, heartbeat, output: () => output };
}

test('disabled app (config error, exit 3, three times): FATAL with the message, exit code 1', async () => {
  const b = runBridge('config-error');
  const result = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('still running'), 15_000))]);
  assert.deepEqual(result, { code: 1, signal: null }, b.output());
  assert.match(b.output(), /FATAL: .*The specified app is not enabled\. \(code 20069\)\. Hint: run `lark-cli config init`/);
  const hb = b.heartbeat();
  assert.equal(hb?.connection, 'down');
  assert.deepEqual(hb?.listeners, { messages: 'down', cards: 'down' }, 'no listener claims to be listening');
  assert.doesNotMatch(b.output(), /lark-cli exited with code 3/, 'the FATAL line carries Lark\'s own message');
});

test('a listener that fails once then connects: restarted, process stays up, heartbeat says listening', async () => {
  const b = runBridge('config-error-once');
  assert.ok(await waitUntil(() => /restarting in/.test(b.output()), 5000), b.output());
  assert.ok(await waitUntil(() => b.heartbeat()?.connection === 'listening' && /restarting in/.test(b.output()), 6000),
    `heartbeat: ${JSON.stringify(b.heartbeat())}`);
  assert.match(b.output(), /\[event\] ready event_key=im\.message\.receive_v1/, 'listening came from the ready line');
  assert.deepEqual(b.heartbeat().listeners, { messages: 'listening', cards: 'listening' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(isAlive(b.child.pid), `the process is still up\n${b.output()}`);
  assert.doesNotMatch(b.output(), /FATAL/);

  b.child.kill('SIGTERM');
  assert.deepEqual(await b.exited, { code: 0, signal: null }, 'SIGTERM is the clean way out');
  const last = b.heartbeat();
  assert.equal(last.connection, 'closed');
  assert.deepEqual(last.listeners, { messages: 'closed', cards: 'closed' }, 'the final beat shows both listeners closed');
});

test('listeners that keep dropping: the process stays up, heartbeat says down, never exits 0 on its own', async () => {
  const b = runBridge('transient');
  assert.ok(await waitUntil(() => b.heartbeat()?.connection === 'down', 5000), JSON.stringify(b.heartbeat()));
  // Long enough to cover the gap between restarts, where an unref'd restart timer would let Node exit 0.
  await new Promise((r) => setTimeout(r, 4000));
  assert.ok(isAlive(b.child.pid), `the process is still up\n${b.output()}`);
  assert.doesNotMatch(b.output(), /FATAL/, 'transient exits are retried, not fatal');
  b.child.kill('SIGTERM');
  await b.exited;
});

test('foreground run with --env-file: the config reader picks the file up and the bridge starts', async () => {
  const dirs = tempDirs();
  const envFile = join(dirs.root, 'bridge.env');
  writeFileSync(envFile, [
    '# a comment line, as in bridge/example.env',
    `BRIDGE_WORKDIR=${dirs.workdir}`,
    `CLAUDE_BIN=${FAKE_CLAUDE}`,
    `BRIDGE_ALLOWED_USERS=${ME}`,
    `BRIDGE_STATE_DIR=${dirs.stateDir}`,
    `LARK_CLI=${FAKE_LARK}`,
    'FAKE_LARK_MODE=quiet',
    '',
  ].join('\n'));
  // Only HOME and PATH come from outside: everything the bridge needs is in the file.
  const child = spawn(process.execPath, [`--env-file=${envFile}`, ENTRY], {
    cwd: dirs.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: process.env.HOME, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  started.push(child);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const hb = () => {
    const f = join(dirs.stateDir, 'heartbeat.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  };
  assert.ok(await waitUntil(() => /bridge started; 1 allowed sender/.test(out) && hb()?.connection === 'listening', 6000), out);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('bridge/example.env parses with --env-file and names every variable from the bridge.mjs header', () => {
  const header = readFileSync(ENTRY, 'utf8');
  const example = readFileSync(join(HERE, '..', 'example.env'), 'utf8');
  const named = [...new Set([...header.matchAll(/\b(BRIDGE_[A-Z_]+|CLAUDE_BIN|LARK_CLI|LARK_PROFILE)\b/g)].map((m) => m[1]))];
  for (const v of named) assert.match(example, new RegExp(`^#? ?${v}=`, 'm'), `${v} is in example.env`);
  assert.doesNotMatch(example, /ou_[0-9a-f]{8,}|\/Users\/(?!YOUR_USER)/, 'placeholders only');
  // And Node itself accepts the file: required values set, commented ones left unset.
  const r = spawnSync(process.execPath, [`--env-file=${join(HERE, '..', 'example.env')}`, '-e',
    'console.log(JSON.stringify([process.env.BRIDGE_ALLOWED_USERS, process.env.BRIDGE_BOT_ID ?? null]))'],
  { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['ou_xxx', null]);
});
