// run-claude.mjs against the fake claude: the cage, the watchdog, the hard cap, the stop,
// the dead resume. Timings are compressed (see FAST_LIMITS).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runClaude, buildArgs, checkCage, cleanEnv, denialInput, WANTED } from '../run-claude.mjs';
import {
  FAKE_CLAUDE, FAST_LIMITS, tempDirs, fakeEnv, fakeRuns, grandchildren, isAlive,
  waitUntil, killQuietly, collectLog,
} from './helpers.mjs';

const leftovers = [];
after(() => leftovers.forEach((pid) => killQuietly(pid)));

function run(mode, { sessionId, idleMs = FAST_LIMITS.IDLE_MS, hardCapMs = FAST_LIMITS.HARD_CAP_MS, extraEnv } = {}) {
  const dirs = tempDirs();
  const log = collectLog();
  const handle = runClaude({
    prompt: 'hello', sessionId, workdir: dirs.workdir, claudeBin: FAKE_CLAUDE,
    idleMs, hardCapMs, pipeForceMs: FAST_LIMITS.PIPE_FORCE_CLOSE_MS,
    env: fakeEnv(dirs, mode, extraEnv), log,
  });
  return { dirs, log, handle };
}

test('args: argv prompt, --tools allowlist, acceptEdits, strict MCP, never a bypass flag', () => {
  const args = buildArgs('rm -rf / ; $(id)', 'sess-1', { model: 'm' });
  assert.equal(args[args.indexOf('-p') + 1], 'rm -rf / ; $(id)');         // one argv element, no shell
  assert.equal(args[args.indexOf('--tools') + 1], WANTED.join(','));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.some((a) => /dangerously|bypass/i.test(a)));
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-1');
});

test('clean env carries USER and SHELL and nothing inherited', () => {
  const env = cleanEnv({ HOME: '/h', USER: 'u', LANG: 'C', ANTHROPIC_BASE_URL: 'http://x', SECRET: 's' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'SHELL', 'TERM', 'USER']);
  assert.equal(env.USER, 'u');
  assert.equal(env.SHELL, '/bin/zsh');
});

test('checkCage: exact match passes, order does not matter', () => {
  assert.equal(checkCage({ tools: [...WANTED].reverse(), permissionMode: 'acceptEdits' }), null);
  assert.ok(checkCage({ tools: [...WANTED, 'Bash'], permissionMode: 'acceptEdits' }));
  assert.ok(checkCage({ tools: WANTED, permissionMode: 'bypassPermissions' }));
  assert.ok(checkCage({ tools: WANTED.slice(1), permissionMode: 'acceptEdits' }));
});

test('normal run: init found after a hook event, result collected', async () => {
  const { handle } = run('normal');
  const res = await handle.done;
  assert.equal(res.sawInit, true);
  assert.equal(res.isError, false);
  assert.equal(res.stoppedReason, null);
  assert.match(res.text, /^ok: hello/);
  assert.ok(res.sessionId);
});

test('log lines: "cage ok" once per run with sorted tools; no "denied" line when nothing was denied', async () => {
  const { handle, log } = run('normal');
  await handle.done;
  assert.deepEqual(log.lines.filter((l) => l.startsWith('cage ok')), ['cage ok: tools=Edit,Glob,Grep,Read,Write mode=acceptEdits']);
  assert.ok(!log.lines.some((l) => l.startsWith('denied:')));
});

test('denialInput: path, command or pattern, cut to 120 characters', () => {
  assert.equal(denialInput({ file_path: '/etc/hosts', content: 'x' }), '/etc/hosts');
  assert.equal(denialInput({ command: 'rm -rf /\n  now' }), 'rm -rf / now');
  assert.equal(denialInput({ command: 'x'.repeat(200) }).length, 120);
  assert.equal(denialInput({ other: 1 }), '{"other":1}');
});

test('permission_denials are logged', async () => {
  const { handle, log } = run('denied');
  const res = await handle.done;
  assert.equal(res.permissionDenials.length, 1);
  assert.ok(log.lines.includes('denied: Write /etc/hosts'), log.lines.join('\n'));
});

test('silent hang: the watchdog kills it and the group dies with it', async () => {
  const { handle, dirs } = run('silent-hang');
  const res = await handle.done;
  assert.equal(res.stoppedReason, 'idle');
  const { inGroup } = grandchildren(dirs);
  assert.ok(inGroup, 'fake spawned a grandchild');
  assert.ok(await waitUntil(() => !isAlive(inGroup), 2000), 'grandchild in the group was killed');
});

test('tool-open hang: NOT killed by the watchdog, only by the hard cap', async () => {
  const started = Date.now();
  const { handle } = run('tool-open-hang', { idleMs: 800, hardCapMs: 3000 });
  const res = await handle.done;
  const took = Date.now() - started;
  assert.equal(res.stoppedReason, 'hardcap');
  assert.ok(took >= 3000, `ran ${took} ms, several idle periods without being killed`);
});

test('cage breach, extra tool: stopped before any result', async () => {
  const { handle, log } = run('cage-extra-tool');
  const res = await handle.done;
  assert.equal(res.stoppedReason, 'cage');
  assert.match(res.cageBreach.loaded, /Bash/);
  assert.equal(res.sawResult, false);
  assert.ok(log.has('CAGE BREACH'));
});

test('cage breach, bypass mode in init: stopped', async () => {
  const { handle, log } = run('cage-bypass');
  const res = await handle.done;
  assert.equal(res.stoppedReason, 'cage');
  assert.equal(res.cageBreach.permissionMode, 'bypassPermissions');
  assert.ok(log.has('CAGE BREACH'));
  assert.ok(!log.has('cage ok'), 'no "cage ok" line for a breached run');
});

test('dead resume: retried once without --resume, new session id', async () => {
  const { handle, dirs } = run('dead-resume', { sessionId: 'dead-session-id' });
  const res = await handle.done;
  const runs = fakeRuns(dirs);
  assert.equal(runs.length, 2);
  assert.ok(runs[0].argv.includes('--resume'));
  assert.ok(!runs[1].argv.includes('--resume'));
  assert.equal(res.retriedFresh, true);
  assert.equal(res.isError, false);
  assert.notEqual(res.sessionId, 'dead-session-id');
});

test('crash after a Write: no result, reported as such, never retried', async () => {
  const { handle, dirs } = run('crash-after-write');
  const res = await handle.done;
  assert.equal(res.sawResult, false);
  assert.equal(res.exitCode, 1);
  assert.equal(fakeRuns(dirs).length, 1);
});

test('stop mid-run kills the group and forces the pipes even if a grandchild escaped', async () => {
  const { handle, dirs } = run('tool-open-hang', { hardCapMs: 60_000, extraEnv: { FAKE_CLAUDE_ESCAPEE: '1' } });
  assert.ok(await waitUntil(() => grandchildren(dirs).escapee, 3000), 'fake started its grandchildren');
  const { inGroup, escapee } = grandchildren(dirs);
  leftovers.push(escapee);
  const pid = handle.pid;

  handle.stop('user');
  const res = await handle.done;                       // resolves only because the pipes were forced
  assert.equal(res.stoppedReason, 'user');
  assert.ok(await waitUntil(() => !isAlive(pid), 2000), 'claude itself is dead');
  assert.ok(await waitUntil(() => !isAlive(inGroup), 2000), 'grandchild in the group is dead');
  assert.ok(isAlive(escapee), 'the escapee is outside the group, which is why the pipes must be forced');
  killQuietly(escapee);
});
