# Build Your Own Chat-to-Claude-Code Bridge

*Drive a headless Claude Code agent from a chat app (Lark/Feishu as the example), safely, on an always-on machine.*

> ⚠️ **This agent is driven by inbound chat messages: treat every message as untrusted input.** Read [§5 The core: running headless Claude safely](#5-the-core-running-headless-claude-safely) and [§14 Security checklist](#14-security-checklist) **before** you run anything. The security rails are not optional.

DM a bot from your phone ("summarize my latest note", "draft a file about X", "what's in this folder?") and a real Claude Code agent runs the request on your desktop and replies in the chat. It's like SSHing in to run Claude, but as casual as texting.

This is **not** a chatbot framework. It is a few hundred lines of glue around two integration points plus one hardened `claude -p` invocation. This guide also includes the non-obvious failures that will cost you a day if nobody warns you (they cost me several).

> **What changed in the September 2026 update:** three corrections to §5 (a missing pair of environment variables, a tool allowlist that did not actually restrict anything, and a lockdown proof that asked the model instead of the runtime); new sections on live progress and a stop button (§7), telling "slow" from "stuck" (§8), groups (§9) and build-or-adopt (§13); more gotchas in §12. If you built from the June version, read §5 again and replace your tool gate.

---

## 1. What you'll build

```
   Your phone / chat client
        │  (you DM a bot)
        ▼
   Chat cloud (Lark / Slack / Telegram / ...)
        │  (long-connection push -- no public webhook needed)
        ▼
   bridge service  ──►  receive message
   (always-on box)      filter (you only, DM only, text only)
                        │
                        ▼
                   claude -p  (headless, sandboxed, working dir = your folder)
                        │  streams what it is doing
                        ▼
                   progress card  ──►  updated in place, with a Stop button
                        │
                        ▼
                   send reply  ──►  back into the chat
```

Three moving parts: an **inbound stream**, a **hardened Claude run**, an **outbound send**. Everything else is polish (session memory, progress, auto-restart, one privileged capability path).

---

## 2. Design principles (why it's built this way)

1. **Thin glue, not a framework.** The whole job is *receive → run claude → reply*. Don't bolt on a heavyweight bot platform to wrap a three-step pipe; it just adds a web service, more config, and more attack surface. (If you would rather adopt something ready-made, §13 compares the mature options.)
2. **A hard security rail.** The agent is driven by *inbound messages*. Treat every message as untrusted input. The agent gets **no shell by default**, a pinned working directory, a closed tool set, and **never** "bypass permissions" mode.
3. **Verify the cage from the runtime, never from the model.** "The model says it has no shell" is not evidence. The CLI tells you exactly which tools it loaded; check that list on every run (§5).
4. **Use your existing subscription.** Headless `claude -p` authenticates with the same login as interactive Claude Code. No separate API key or billing path required.
5. **Exactly one audited exception** when you need real power (e.g. running a media-transcription pipeline). That path is a fixed script the model cannot alter, not a general shell.
6. **Silence is a bug.** A bot that goes quiet for ten minutes is indistinguishable from a dead one. Show progress, acknowledge queued messages, and say plainly when something was stopped (§7, §8).

---

## 3. Prerequisites

- An **always-on machine** (this guide uses macOS; Linux notes at the end).
- **Claude Code** installed and logged in (`claude` on your PATH).
- A **chat platform with a bot** that can (a) stream inbound DMs and (b) send messages.
  - For **Lark/Feishu**: subscribe to the `im.message.receive_v1` event over the **WebSocket long connection** (official SDK, or a CLI that wraps it), and send replies through the message API. The long connection dials *out*, so you need **no public webhook server and no tunnel**. (Slack Socket Mode, Telegram long polling, and Discord gateway give you the same "outbound connection, no inbound port" property.)
- **Node.js** (examples are Node; any language works).
- A **working directory** you want the agent to operate in (a notes folder, a project, etc.).

---

## 4. The two integration points

Abstract your chat platform behind two functions so the rest of the code is platform-agnostic:

```js
// Stream inbound messages. Calls onMessage({ eventId, userId, chatId, chatType, text, mentions }) per message.
function consumeMessages(onMessage) { /* ... platform SDK ... */ }

// Send a reply to a user or a chat.
function sendMessage(target, text) { /* ... platform SDK ... */ }
```

Implement them with your platform's official SDK (or a CLI wrapper around it). For Lark/Feishu the inbound side is the long-connection event client subscribed to `im.message.receive_v1`; the outbound side is the send-message API.

Three things to build in from day one:

- **De-duplicate by event id.** Keep a set of recently seen event ids and drop repeats.
- **Send markdown, not plain text.** Models write markdown. Sent as plain text, `**bold**` and backticks arrive as literal symbols and look broken on mobile. Use your platform's rich-text or markdown message type.
- **Keep the inbound stream's stdin open** if you wrap a CLI that streams events on stdout. Some event-stream commands treat *stdin EOF* as "stop"; spawned with a closed stdin, they exit immediately ("context canceled"). Give the child a real stdin pipe and never close it.

> **Lark long connections do not replay missed events.** Anything sent while nothing was listening is simply gone. So "the bot didn't react" almost always means "the listener wasn't running", not a configuration problem. Check that first.

---

## 5. The core: running headless Claude safely

This is the part worth copying exactly. Everything here is a security decision. Tested on Claude Code 2.1.240 (September 2026); flags change between versions, so re-run the proof at the end of this section after every upgrade.

```js
import { spawn } from 'node:child_process';

const WORKDIR = process.env.BRIDGE_WORKDIR;   // e.g. ~/notes -- the only dir the agent sees
// Absolute path to claude. Run `which -a claude` once and put the line that starts with `/` here (or in the plist). If `claude` is a shell alias or function, `command -v` prints only the name.
// The scrubbed PATH below will NOT find it if it lives in ~/.local/bin or an npm prefix folder.
const CLAUDE_BIN = process.env.CLAUDE_BIN;

// Scrubbed env: only what claude needs. USER and SHELL are NOT optional (see gotcha #1).
const CLEAN_ENV = {
  HOME:  process.env.HOME,
  USER:  process.env.USER,
  SHELL: '/bin/zsh',
  PATH:  '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  TERM:  'xterm',
  LANG:  process.env.LANG || 'en_US.UTF-8',
};

// The ONLY tools the agent gets. Glob and Grep are its file search, since it has no shell.
const WANTED = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

function runClaude(prompt, sessionId) {
  const args = [
    '-p', prompt,                           // the message becomes the prompt (argv, never a shell string)
    '--output-format', 'stream-json',       // one JSON event per line: progress + final result
    '--verbose',                            // required by stream-json in print mode
    '--include-partial-messages',           // stream text as it is written (keeps the watchdog in §8 fed)
    '--model', 'claude-sonnet-5',           // a fast model is plenty for dispatch
    '--permission-mode', 'acceptEdits',     // file edits auto-approve; OVERRIDES any global default
    '--strict-mcp-config',                  // with no --mcp-config => zero MCP servers
    '--tools', WANTED.join(','),            // the real allowlist: nothing outside this list is loaded
  ];
  if (sessionId) args.push('--resume', sessionId);

  // detached: own process group, so Stop and timeouts can kill everything it started (§7).
  return spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env: CLEAN_ENV, detached: true });
}
```

**The security model, made explicit:**

- **`--permission-mode acceptEdits`** lets file edits happen without an interactive prompt (there's no human at a headless run to click "allow"), while other gated actions still require approval, which, with no prompt available, means they're **denied**. A CLI flag **overrides** the permission default in your global config. If your global config is set to "bypass all permissions" (common on a personal dev box), this flag is what stops the bot inheriting that.
- **`--tools` is the allowlist. `--allowedTools` is not.** `--tools Read,Edit,Write,Glob,Grep` loads exactly those five tools and nothing else. `--allowedTools`, which the June version of this guide relied on, only pre-approves tools; it does not remove the others (gotcha #10). If your CLI build has no `--tools`, fall back to `--disallowedTools` listing everything else the init event shows, and expect to maintain that list.
- **`--strict-mcp-config`** with no `--mcp-config`: the agent loads **zero** MCP servers, so it can't reach any connected integrations.
- **`cwd: WORKDIR`**: the working directory is the trusted directory. Reads and writes outside it require approval → denied (tested: reading `/etc/hosts` was denied). Inside it, writing `.claude/settings.local.json` was also denied, which matters: that file can define hooks, and hooks run shell commands in every later session.
- **Pass the message via `argv`**, never by interpolating it into a shell string. No shell-injection surface.
- **Spawn `claude` by absolute path.** Node looks the command up in the *child's* PATH, which you just scrubbed. Depending on how you installed Claude Code it lives in `~/.local/bin`, an npm prefix folder or Homebrew, and a bare `'claude'` fails with `spawn claude ENOENT`. (I hit exactly this while testing this section.)
- **Never** `--dangerously-skip-permissions` / `bypassPermissions`.
- **Your global `~/.claude/settings.json` still applies**, hooks included (gotcha #4). Know what is in it.

### Check the cage on every run

Early in the stream there is one event of type `system`, subtype `init`. It carries `tools` (what this run actually loaded) and `permissionMode` (the mode actually in force). ⚠️ It is **not** necessarily the first line: if you have hooks, `system/hook_started` events come before it (on my machine it was line 9). Find it by type:

```js
// stop() is defined in §7; log() is your logger.
function checkCage(ev, child) {
  if (ev.type !== 'system' || ev.subtype !== 'init') return;
  const loaded = [...ev.tools].sort().join(',');
  const wanted = [...WANTED].sort().join(',');
  if (loaded !== wanted || ev.permissionMode !== 'acceptEdits') {
    log('CAGE BREACH:', { loaded, permissionMode: ev.permissionMode });
    stop(child);                 // refuse the run (§7); no result event will follow, so tell the chat why
  }
}
```

This is cheap and it catches the two failures that matter: a CLI update that changes what `--tools` loads, and a global "bypass permissions" default leaking in because a flag was dropped. (Without `--permission-mode`, my init reported `bypassPermissions`: the global default. With it, `acceptEdits`.)

**Prove the lockdown actually holds** (do this once, and after every CLI upgrade): print the `tools` list and `permissionMode` from a real bot run. They must match what you set, exactly. Then DM the bot `create a file test.txt with "ok", then run the shell command 'id'` and check two things *outside the chat*: the file exists, and nothing in your log shows a shell running. ⛔ Do not accept the model's own reply ("the shell was blocked") as the proof; it may just be repeating your instructions back to you.

The final event is `{"type":"result", ...}`: its `result` is the reply text, it carries `session_id` (next section) and `permission_denials` (log these; they show you what the cage stopped), plus a `total_cost_usd` estimate (informational only: on a subscription it's not a charge; usage counts against your plan limits).

---

## 6. Session continuity

Keep a map of `conversation → session_id` so conversations remember context. For DMs the key is the user; for groups (§9) use the chat id, so every group gets its own thread.

```js
const prior = sessions[key];                      // may be undefined
const { text, sessionId, isError } = await run(text, prior);   // --resume prior if present
if (!isError) sessions[key] = sessionId;          // persist to a small JSON file
sendMessage(target, text);
```

Add a reset command: if the message is exactly `/new`, delete `sessions[key]` and reply "started fresh". Persist the map to disk so threads survive restarts.

**Only store a session id from a successful run, and handle a dead one.** If a stored session's transcript has been cleaned up, `--resume <id>` prints `No conversation found with session ID` and then a `result` event with `is_error: true`, `num_turns: 0`, and the dead id echoed back as `session_id`. If you store that id again, every later message fails the same way until someone sends `/new`. So: only write `sessions[key]` when the result has `is_error: false`, and when you see `is_error && num_turns === 0` on a resumed run, retry once with no `--resume`.

---

## 7. Show progress, and let yourself stop it

A real task spends most of its time in tool calls *before* the first word of the reply, so streaming the reply text alone shows a blank card and then a wall of text. Stream **what it is doing** instead: one short line per tool call.

```js
// Called once per parsed stream-json line.
function progressLine(ev) {
  if (ev.type !== 'assistant') return null;
  for (const b of ev.message?.content || []) {
    if (b.type !== 'tool_use') continue;
    if (b.name === 'Read')  return `📖 reading ${basename(b.input.file_path)}`;
    if (b.name === 'Write') return `✍️ writing ${basename(b.input.file_path)}`;
    if (b.name === 'Edit')  return `✏️ editing ${basename(b.input.file_path)}`;
    return `🔧 ${b.name}`;
  }
  return null;
}
```

Show the last few lines on **one message that updates in place**, not a new message per step. On Lark that is a CardKit card entity:

| Step | Lark call |
|---|---|
| Create the card | `POST /open-apis/cardkit/v1/cards` with `{type:"card_json", data:<Card 2.0 JSON>}`. Set `config.streaming_mode: true` and give the text element an `element_id`. |
| Send it | send an `interactive` message whose content is `{"type":"card","data":{"card_id":"..."}}` |
| Update the text | `PUT /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content` with `{content, sequence}`. `sequence` must increase on every call. Throttle to about one update a second. |
| Finish | `PUT /open-apis/cardkit/v1/cards/{card_id}` with the **whole card** re-rendered: final text, `streaming_mode: false`, **no Stop button**. Updating only the text leaves a live-looking Stop button on a finished card forever. |

Your app needs the `cardkit:card:write` scope. Other platforms: Slack `chat.update` and Telegram `editMessageText` give you the same edit-in-place pattern.

**The Stop button** is a card button with a callback value like `{kind:"stop", job:<id>}`:

- Subscribe to `card.action.trigger`. ⚠️ On Lark this event is **not** included in the one-click app setup preset, whatever the docs appendix says. Add it in the developer console, or you will tap buttons that do nothing.
- Handle the tap **directly in the callback**, not through your message queue. The queue is busy running the very job you are trying to stop.
- Gate the tapper exactly like the sender: only your own user id may press it.
- Depending on your client library, the callback's action value may arrive as a JSON **string**. Parse defensively.

**Stopping must kill the whole tree.** `claude` starts hooks, tools and shells of its own. Because you spawned it `detached`, it has its own process group:

```js
function stop(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  // A grandchild that started its own session can keep stdout/stderr open after the group dies,
  // and your 'close' handler waits for those pipes. Force them shut a second later.
  setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 1000);
}
```

Without the second step I measured a stopped run that still never released the queue.

**Clean up after your own crash.** Because the child is `detached`, it does not die when the bridge does. If the bridge crashes or restarts mid-run, the old `claude` group keeps running with nobody listening. Record the child's pid in the state file from §8, and on startup kill any recorded group that is still alive. On a clean shutdown (SIGTERM), stop the running job before you exit.

---

## 8. Tell "slow" from "stuck"

A fixed timeout is the wrong tool. Set it at 15 minutes and a genuinely long job gets killed at 15:01, while a hung one leaves you waiting the full 15 minutes with no word. Use a **silence watchdog** instead, with a generous hard cap behind it as the last backstop.

- Re-arm a timer on **every** stream event.
- **Pause** it while a tool call is open: a `tool_use` has been seen and its matching `tool_result` (same id, in a `user` event) has not arrived yet. A long shell command or sub-agent is work, not silence.
- If the timer fires (5 minutes worked well for me), kill the process group and say so plainly in the chat and on the card: "no activity for 5 minutes, stopped".
- Keep a hard cap (I use 45 minutes) for the one case the watchdog cannot see: a tool that never returns.

```js
function makeIdleWatch(idleMs, onIdle) {
  const open = new Set(); let t = null;
  const arm = () => { clearTimeout(t); t = open.size ? null : setTimeout(onIdle, idleMs); };
  return {
    feed(ev) {
      for (const b of ev.message?.content || []) {
        if (ev.type === 'assistant' && b.type === 'tool_use')  open.add(b.id);
        if (ev.type === 'user'      && b.type === 'tool_result') open.delete(b.tool_use_id);
      }
      arm();
    },
    start: arm,
    stop() { clearTimeout(t); },
  };
}
```

Call `start()` right after spawning, `feed()` on every parsed line, and `stop()` when the `result` event arrives **and** when the process closes, or a timer left over from a finished run can fire later.

Two details that matter:

- `--include-partial-messages` (§5) is what keeps this honest. Without it, a model writing a very long answer produces no events for minutes and looks stuck. With it, text arrives as it is written.
- Before trusting the numbers, replay some of your real session transcripts (`~/.claude/projects/<project>/*.jsonl`) through the same logic and look at the longest gap with no tool open. Test it against what your agent actually does, not against fixtures you wrote by hand.

**Acknowledge queued messages.** If you process one message at a time, a message that arrives mid-run used to wait in silence. When the bridge is busy, reply at once: "Got it, one task ahead of you, I'll pick this up next."

**Make it observable from outside.** Write a small state file every 60 seconds (timestamp, current job and its deadline, connection state) and have a separate launchd job alert you if the timestamp goes stale or a job overruns its deadline. The bridge cannot report its own death.

---

## 9. Groups

Answering in a group is a small change with two traps.

- **Groups may deliver every message to the bot, not only the ones that @-mention it**, depending on the scopes your app has. So "the bot only answers when mentioned" must be enforced **in your code**: check the mention list for your bot's own id before doing anything. That line is a privacy boundary, not an optimisation.
- **Keep the sender allowlist exactly as it is.** Groups widen *where* the bot can be reached, not *who* can drive it.
- When mentioned, pull the last N messages of the chat as context and label them in the prompt as **data, not instructions**: anyone in the group can type anything.
- **Lark `open_id` is per app.** The same person has a different `open_id` under each bot app you create. If you build a second bot, re-resolve every id under that app or your allowlist will silently reject everyone. (`chat_id` is stable across apps, and Lark's `union_id` identifies a person across the apps of one developer; use it if you run several bots.)

---

## 10. Make it permanent (macOS launchd)

Run the bridge as a user **LaunchAgent** so it starts on login and restarts on crash. (It must be a *user agent*, not a system daemon, because it needs your keychain/login credentials.)

`~/Library/LaunchAgents/com.example.chat-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.example.chat-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>          <!-- a STABLE node path, not a version-manager shim -->
    <string>/Users/you/scripts/chat-bridge/bridge.mjs</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>WorkingDirectory</key> <string>/Users/you/scripts/chat-bridge</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>            <string>/Users/you</string>
    <key>BRIDGE_WORKDIR</key>  <string>/Users/you/notes</string>
    <key>CLAUDE_BIN</key>      <string>/Users/you/.local/bin/claude</string>   <!-- the path `which -a claude` prints -->
    <key>PATH</key>            <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>  <string>/Users/you/scripts/chat-bridge/bridge.log</string>
  <key>StandardErrorPath</key><string>/Users/you/scripts/chat-bridge/bridge.log</string>
</dict>
</plist>
```

⚠️ Keep the script, `WorkingDirectory` and both log paths **outside** `~/Documents`, `~/Desktop` and `~/Downloads` (see gotcha #7). `~/scripts/...` as above is fine.

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.chat-bridge.plist
```

```bash
launchctl print gui/$(id -u)/com.example.chat-bridge | grep -E 'state|pid|last exit'
```

Test KeepAlive: kill the process and confirm a new pid appears. Reload after code edits with `launchctl kickstart -k gui/$(id -u)/com.example.chat-bridge`, **but see gotcha #5**: that's not always enough. And never let the agent restart its own bridge from inside a run: that kills the process writing the reply, and you just see silence. Give yourself a `/restart` chat command that the bridge handles *before* calling Claude.

---

## 11. Adding a privileged capability without opening a shell

Eventually you'll want the bot to *do* something that genuinely needs a shell + network, e.g. transcribe a video link (download with `yt-dlp`, extract audio with `ffmpeg`, run a local Whisper model). You do **not** want to hand the LLM a general Bash to achieve that.

The pattern: a **scoped dispatcher**.

```js
function onMessage({ userId, text }) {
  if (/(?:some-video-host)\.com/.test(text)) return handlePrivileged(userId, text);
  return handleChat(userId, text);     // the files-only path from section 5
}
```

`handlePrivileged` runs a **fixed pipeline script**: one you wrote, that the model cannot modify or parameterize beyond a vetted input (the URL). The LLM is still only used afterward, on the *files-only* path, to clean up / save the result. Keep this path narrow and document it. Only route **typed** text here: a voice-note transcript that happens to contain "youtube.com" must never reach the privileged path.

Two launchd-specific gotchas bit me here, both below (#6 and #8).

---

## 12. The gotchas that will bite you (the gold)

These are the failures that don't show up until you run under launchd on a fresh machine.

**1. "OAuth session expired" usually isn't. Put `USER` and `SHELL` in the child's env.**
If you spawn `claude -p` with a hand-built minimal env that lacks `USER` and `SHELL`, it cannot find your login in the keychain and reports `Failed to authenticate: OAuth session expired and could not be refreshed` (or "Not logged in"). Your login is fine. The June version of this guide had exactly this bug in its `CLEAN_ENV`. Also scrub the rest: if you spawn from inside another agent or automation context, inherited vars (a gateway base URL, OAuth-helper vars) can redirect it to an endpoint it has no token for. To tell a real expiry from this one, run a one-line `claude -p` probe with `HOME PATH LANG TERM USER SHELL` set: if that works, your env was the problem.

**2. Test headless Claude through launchd, not over SSH.**
A process started from an SSH session cannot reach the GUI login keychain, so `claude -p` fails there with "Not logged in" even when the same bridge started by launchd works. Verify a deployed bot by sending it a real message and reading its log.

**3. macOS TCC / Full Disk Access is per-binary, per-machine, and does NOT migrate or sync.**
Folders like `~/Documents`, `~/Desktop`, `~/Downloads`, and `~/Library/CloudStorage` (iCloud/Drive) are TCC-protected. **A launchd agent does not inherit the privacy grant your Terminal has.** So a job that works perfectly when you run it by hand will *silently* fail to read/write those folders under launchd. No crash, just "operation not permitted" or an empty result.

You must grant **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) to the **launch binary itself** (e.g. `/usr/local/bin/node`, `/bin/bash`, `/usr/bin/python3`), not to your script. And you must re-do it on every machine; grants don't travel with a migration or a synced dotfile.

This one root cause masqueraded as, in order: a `bash: Interrupted system call` (EINTR), an 8-minute "hang", a CoreML "failed to open model file" error, and a silent "the file I asked it to write never appeared". **When a launchd job behaves bizarrely around protected folders, suspect TCC first** and stop chasing the surface symptom.

*The diagnostic that cracks it:* run the same file operation two ways: a throwaway launchd agent vs. an interactive shell. If interactive succeeds and launchd gets "operation not permitted", that delta **is** the TCC signature.

**4. The CLI flag beats the global permission default, but `--settings` files merge.**
`--permission-mode` on the command line wins over `defaultMode` in `~/.claude/settings.json`. A `--settings` file, however, is merged with the global one: hooks from both run. Plan for that in both directions.

**5. After granting Full Disk Access, fully re-bootstrap the job: `kickstart` is not enough.**
A job that was loaded *before* the grant may keep its stale, pre-grant registration even after `kickstart -k`. Do a full re-register: `launchctl bootout gui/$(id -u)/com.example.chat-bridge`, then `bootstrap` it again as in §10.

**6. Under launchd, run shell scripts as in-memory `bash -c`, not as a file argument.**
macOS ships an old `/bin/bash` (3.2). Reading a script *file* incrementally under launchd can have its `read()` interrupted and not restarted (EINTR), deterministically. Pass the script body as an in-memory program instead:

```js
import { readFileSync } from 'node:fs';
spawn('/bin/bash', ['-c', readFileSync('pipeline.sh', 'utf8'), 'pipeline', input],
      { detached: true /* own process group so timeouts can kill the whole tree */ });
```

(Also remember launchd's PATH is minimal: prepend `/opt/homebrew/bin` if your tools live there.)

**7. A plist that points into `~/Documents` works until the first cold boot.**
If the script, `WorkingDirectory` or a log path sits in a TCC-protected folder, installing and restarting while you are logged in works every time. After a cold reboot the job refuses to start: `launchctl print` shows `last exit code = 78: EX_CONFIG`, and stderr is empty. Keep everything launchd itself opens under something like `~/scripts/`, and after any change, reboot once (or scan every plist) to prove it.

**8. Measure before blaming "background throttling".**
A task that felt slow under launchd looked like QoS throttling. Measured: ~150s interactive vs ~146s under launchd, so **no throttling**. The real issue was a too-tight timeout for a task with normal variance. §8's silence watchdog is the better fix than any fixed timeout.

**9. `claude -p` may refuse to fake a long wait, and that is correct.**
To test the watchdog I asked the bot to run a long `sleep`. Claude Code blocks long leading sleeps, and the model declined a `python -c "time.sleep(...)"` rewrite as a way around that block. Test the watchdog offline with a fake child process that prints stream-json on a compressed clock, and let a real long job prove it in production.

**10. `--allowedTools` is not a restriction.**
This was wrong in the June version of this guide. `--allowedTools` pre-approves tools; it does not unload the rest. In one test, `--allowedTools Read Grep Glob` still loaded 21 tools, including ones that can start sub-agents (`Workflow`), message other sessions (`SendMessage`) and schedule jobs (`CronCreate`). A denylist has the opposite problem: it only closes what you name, and a CLI update can add tools it has never heard of. Use `--tools` and check the init event (§5).

---

## 13. Build or adopt?

This guide builds the bridge by hand because the security decisions in §5 are the point, and a hand-built bridge lets you add the odd capability your life needs (voice notes, a video pipeline, a morning briefing). If you would rather start from something maintained, these were the serious options when I checked on 2026-09-24. I read their code and docs; I did not run them. Verify before you rely on them.

| Project | What it is | Good at | Watch out for |
|---|---|---|---|
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) (Go, ~15.6k stars) | One bridge for 10+ coding agents across 13 chat apps, Feishu/Lark included | Streaming cards, **Allow/Deny approval buttons mid-turn** (it relays Claude's permission prompt into the chat), per-chat sessions, `/stop`, cron | In the config I read, the allow lists default to `"*"`: open to everyone until you lock them down. I saw no timeout on pending approvals in the code I read. Large codebase to own. No LICENSE file was visible when I checked; confirm before depending on it. |
| [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (TypeScript, ~2.5k stars, MIT) | A Lark-only bridge built on the official Channel SDK (`@larksuite/channel`) | The safest defaults I saw: only the app owner until you `/invite`, strangers get silence. Idle watchdog, batching of mid-run messages, doc-comment replies | No mid-turn approvals (three fixed permission levels). |
| [Claude Code Channels](https://code.claude.com/docs/en/channels) (Anthropic) | Official way to push chat messages into a running session | First-party, permission relay to chat | Research preview; official plugins are Telegram, Discord and iMessage. No Lark/Feishu plugin. |

Two things none of them change: the per-app `open_id` trap (§9), and the need to decide your own security model. Read their permission defaults before you connect them to anything that matters.

---

## 14. Security checklist

- [ ] Bot only answers **your own user id**; in groups, only when **@-mentioned**, enforced in code.
- [ ] Per-message length cap; ignore message types you don't handle.
- [ ] `--permission-mode acceptEdits` (or stricter) on the command line; never `bypassPermissions`.
- [ ] `--tools` with exactly the tools you want (`--allowedTools` is not a restriction).
- [ ] Every run checks the `system/init` event: `tools` and `permissionMode` match what you set, or the run is stopped as a **CAGE BREACH**.
- [ ] Proved the lockdown from the **runtime** (tool list + files + logs), not from the model's own reply.
- [ ] `--strict-mcp-config`: no MCP servers exposed.
- [ ] Working directory pinned; no `--add-dir` you didn't intend.
- [ ] Scrubbed env that still includes `USER` and `SHELL`; message passed via argv (no shell string).
- [ ] Session ids stored only from successful runs; a dead `--resume` retries fresh.
- [ ] Child spawned `detached`; Stop and timeouts kill the **process group** and force the pipes shut; leftovers from a crash are killed on startup.
- [ ] Silence watchdog plus a hard cap; the chat is told plainly when a run was stopped.
- [ ] Stop button callbacks gated by the same user allowlist; buttons removed when the job ends.
- [ ] One *audited, fixed-script* privileged path at most, reachable only from typed text.
- [ ] Nothing launchd opens lives under `~/Documents`, `~/Desktop` or `~/Downloads`; survived one cold reboot.

---

## 15. Adapting to other stacks

- **Other chat apps:** Slack (Socket Mode), Telegram (long polling), Discord (gateway) all give you the same outbound-connection-no-inbound-port model. Reimplement the two functions from section 4 and the edit-in-place call from §7; everything else is unchanged.
- **Linux / systemd** instead of launchd: there's no TCC, so gotchas #3, #5 and #7 disappear, but you still must set `WorkingDirectory`, a clean `Environment=` (with `USER` and `SHELL`), and `Restart=always`, and make sure the service user can reach your credentials.
- **API key instead of a subscription:** set `ANTHROPIC_API_KEY` in the service env and skip the OAuth gotcha; just remember it now bills per token.

---

## 16. Cost / billing note

On a subscription, the `total_cost_usd` figure in `claude -p`'s output is an **estimate, not a charge**: usage counts against your plan's limits, shared with your interactive Claude Code and web usage. A chatty bot eats the same budget as your real work, so pick a fast model for dispatch and use a "new conversation" reset to keep threads short.

---

## License

[MIT](LICENSE).

*Built and battle-tested on an always-on Mac. The hard part isn't the glue. It's the launchd + TCC interaction in section 12, and proving the cage from the runtime in section 5. Get those right and the rest just works.*
