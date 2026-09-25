// The hardened `claude -p` run (README §5). Every line here is a security decision.
//
// What this module guarantees for each run:
//   - the child gets a scrubbed env that still carries USER and SHELL;
//   - the message travels as one argv element, never through a shell string;
//   - `--tools` is the allowlist (`--allowedTools` only pre-approves, it removes nothing);
//   - `--permission-mode acceptEdits` on the command line overrides any global default;
//   - `--strict-mcp-config` with no `--mcp-config` loads zero MCP servers;
//   - the child is `detached`, so stopping it kills its whole process group;
//   - the `system/init` event is checked against WANTED, and a mismatch stops the run
//     as a CAGE BREACH before it can act;
//   - `permission_denials` from the result are logged, one line each, because they show
//     what the cage stopped;
//   - a dead `--resume` is retried once without it.

import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { makeIdleWatch } from './idle-watch.mjs';

// The ONLY tools the agent gets. Glob and Grep are its file search, since it has no shell.
export const WANTED = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
export const WANTED_MODE = 'acceptEdits';

// How long after a group kill to force the pipes shut. A grandchild that started its own
// session can keep stdout open after the group is dead, and 'close' waits for the pipes.
export const PIPE_FORCE_CLOSE_MS = 1000;

// What `claude --resume <id>` prints when the stored transcript is gone.
const DEAD_RESUME_TEXT = 'No conversation found with session ID';

// Scrubbed env: only what claude needs. USER and SHELL are NOT optional: without them it
// cannot find your login in the keychain and reports "OAuth session expired" (gotcha #1).
// launchd usually injects USER into agents even when the plist omits it; the fallback to
// userInfo() covers the case where it does not.
export function cleanEnv(parent = process.env) {
  return {
    HOME: parent.HOME,
    USER: parent.USER || userInfo().username,
    SHELL: '/bin/zsh',
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    TERM: 'xterm',
    LANG: parent.LANG || 'en_US.UTF-8',
  };
}

export function buildArgs(prompt, sessionId, { model } = {}) {
  const args = [
    '-p', prompt,                           // the message becomes the prompt (argv, never a shell string)
    '--output-format', 'stream-json',       // one JSON event per line: progress + final result
    '--verbose',                            // required by stream-json in print mode
    '--include-partial-messages',           // stream text as it is written (keeps the watchdog fed)
    '--permission-mode', WANTED_MODE,       // file edits auto-approve; OVERRIDES any global default
    '--strict-mcp-config',                  // with no --mcp-config: zero MCP servers
    '--tools', WANTED.join(','),            // the real allowlist: nothing outside this list is loaded
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

// Returns null when the cage holds, or a description of the breach.
// The init event is NOT necessarily the first line: with hooks installed, system/hook_*
// events come first. Callers find it by type and subtype.
// bypassPermissions is never acceptable; it appears here only as a value that fails the check.
export function checkCage(ev) {
  const loaded = [...(ev.tools || [])].sort().join(',');
  const wanted = [...WANTED].sort().join(',');
  if (loaded !== wanted || ev.permissionMode !== WANTED_MODE) {
    return { loaded, wanted, permissionMode: ev.permissionMode };
  }
  return null;
}

// The part of a denied call worth a log line: the path, command or pattern, cut to 120.
export function denialInput(input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.file_path ?? input.command ?? input.path ?? input.pattern ?? input.url ?? JSON.stringify(input);
  const s = String(pick).replace(/\s+/g, ' ');
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

// Kill the whole process group, then force the pipes shut a moment later.
export function killGroup(child, pipeForceMs = PIPE_FORCE_CLOSE_MS) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  const t = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, pipeForceMs);
  t.unref();
}

// One attempt: spawn, stream, watch, check the cage, collect the result.
function runOnce(opts, sessionId) {
  const {
    prompt, workdir, claudeBin, model, idleMs, hardCapMs,
    onEvent = () => {}, onSpawn = () => {}, log = console.log, env = cleanEnv(),
    pipeForceMs = PIPE_FORCE_CLOSE_MS,
  } = opts;

  const child = spawn(claudeBin, buildArgs(prompt, sessionId, { model }), {
    cwd: workdir,
    env,
    detached: true,                          // own process group, so a stop reaches everything it started
    stdio: ['ignore', 'pipe', 'pipe'],       // the prompt is in argv; nothing is read from stdin
  });

  const out = {
    text: '', sessionId: null, isError: true, numTurns: null, permissionDenials: [],
    stoppedReason: null, cageBreach: null, sawInit: false, sawResult: false,
    exitCode: null, stderr: '', deadResume: false, resumed: Boolean(sessionId),
  };

  let hardCap = null;
  const stop = (reason) => {
    if (out.stoppedReason || out.sawResult) return;
    out.stoppedReason = reason;
    watch.stop();
    clearTimeout(hardCap);
    killGroup(child, pipeForceMs);
  };

  const watch = makeIdleWatch(idleMs, () => {
    log(`run ${child.pid}: no activity for ${idleMs} ms, stopping`);
    stop('idle');
  });

  const done = new Promise((resolve) => {
    child.on('error', (err) => {             // e.g. spawn ENOENT: CLAUDE_BIN is wrong
      out.stderr += String(err.message);
    });

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (out.stderr.length < 20000) out.stderr += chunk;
    });

    child.on('close', (code) => {
      watch.stop();
      clearTimeout(hardCap);
      out.exitCode = code;
      if (out.stderr.includes(DEAD_RESUME_TEXT)) out.deadResume = true;
      // A successful result from a run whose cage was never checked is not a success.
      if (out.sawResult && !out.sawInit && !out.isError) {
        out.cageBreach = { reason: 'no system/init event, cage not verified' };
        out.isError = true;
        log('CAGE BREACH:', out.cageBreach);
      }
      resolve(out);
    });
  });

  function handleLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }   // not JSON: ignore, never crash on it
    watch.feed(ev);

    if (ev.type === 'system' && ev.subtype === 'init') {
      out.sawInit = true;
      const breach = checkCage(ev);
      if (breach) {
        out.cageBreach = breach;
        log('CAGE BREACH:', breach);
        stop('cage');                        // refuse the run; no result event will follow
        return;
      }
      // One line per run that says what the runtime actually loaded, not what was asked for.
      log(`cage ok: tools=${[...ev.tools].sort().join(',')} mode=${ev.permissionMode}`);
    }

    if (ev.type === 'result') {
      out.sawResult = true;
      out.text = typeof ev.result === 'string' ? ev.result : '';
      out.sessionId = ev.session_id || null;
      out.isError = Boolean(ev.is_error);
      out.numTurns = ev.num_turns ?? null;
      out.permissionDenials = ev.permission_denials || [];
      for (const d of out.permissionDenials) log(`denied: ${d.tool_name} ${denialInput(d.tool_input)}`);
      if (out.text.includes(DEAD_RESUME_TEXT)) out.deadResume = true;
      watch.stop();
      clearTimeout(hardCap);
    }

    try { onEvent(ev); } catch (err) { log('onEvent failed:', err.message); }
  }

  onSpawn(child.pid);
  watch.start();
  hardCap = setTimeout(() => {
    log(`run ${child.pid}: hit the hard cap of ${hardCapMs} ms, stopping`);
    stop('hardcap');
  }, hardCapMs);

  return { child, done, stop };
}

// Public entry point. Returns a handle right away:
//   handle.done   Promise<RunResult>
//   handle.stop(reason)   kill the current attempt's process group
//   handle.pid    pid of the current attempt (changes if the dead-resume retry runs)
//
// RunResult: { text, sessionId, isError, numTurns, permissionDenials, stoppedReason,
//              cageBreach, sawInit, sawResult, exitCode, stderr, deadResume, resumed,
//              retriedFresh }
export function runClaude(opts) {
  const handle = { pid: null, stop: () => {}, done: null };
  let stoppedReason = null;

  const start = (sessionId) => {
    const attempt = runOnce({ ...opts, onSpawn: (pid) => { handle.pid = pid; opts.onSpawn?.(pid); } }, sessionId);
    handle.stop = (reason) => { stoppedReason = reason; attempt.stop(reason); };
    return attempt.done;
  };

  handle.done = (async () => {
    let res = await start(opts.sessionId);
    // Dead resume: the stored transcript is gone. The result is an error with zero turns
    // and echoes the dead id back. Retry once, fresh, and never store that dead id again.
    const dead = res.resumed && res.isError && (res.numTurns === 0 || res.deadResume);
    if (dead && !stoppedReason && !res.cageBreach) {
      (opts.log || console.log)(`resume ${opts.sessionId} is dead, retrying once without --resume`);
      res = await start(null);
      res.retriedFresh = true;
    }
    return res;
  })();

  return handle;
}
