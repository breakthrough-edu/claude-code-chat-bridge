# Build Your Own Chat-to-Claude-Code Bridge

*Drive a headless Claude Code agent from a chat app (Lark/Feishu as the example), safely, on an always-on machine.*

> ⚠️ **This agent is driven by inbound chat messages -- treat every message as untrusted input.** Read [§5 The core: running headless Claude safely](#5-the-core-running-headless-claude-safely) and [§10 Security checklist](#10-security-checklist) **before** you run anything. The security rails are not optional.

DM a bot from your phone -- "summarize my latest note", "draft a file about X", "what's in this folder?" -- and a real Claude Code agent runs the request on your desktop and replies in the chat. It's like SSHing in to run Claude, but as casual as texting.

This is **not** a chatbot framework. It is ~200 lines of glue around two integration points plus one hardened `claude -p` invocation. This guide also includes the non-obvious failures that will cost you a day if nobody warns you (they cost me one).

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
                        │
                        ▼
                   send reply  ──►  back into the chat
```

Three moving parts: an **inbound stream**, a **hardened Claude run**, an **outbound send**. Everything else is polish (session memory, auto-restart, one privileged capability path).

---

## 2. Design principles (why it's built this way)

1. **Thin glue, not a framework.** The whole job is *receive → run claude → reply*. Don't bolt on a heavyweight bot platform to wrap a three-step pipe; it just adds a web service, more config, and more attack surface.
2. **A hard security rail.** The agent is driven by *inbound messages*. Treat every message as untrusted input. The agent gets an explicit tool allowlist, **no shell by default**, a pinned working directory, and **never** "bypass permissions" mode.
3. **Use your existing subscription.** Headless `claude -p` authenticates with the same login as interactive Claude Code. No separate API key or billing path required.
4. **Exactly one audited exception** when you need real power (e.g. running a media-transcription pipeline). That path is a fixed script the model cannot alter -- not a general shell.

---

## 3. Prerequisites

- An **always-on machine** (this guide uses macOS; Linux notes at the end).
- **Claude Code** installed and logged in (`claude` on your PATH).
- A **chat platform with a bot** that can (a) stream inbound DMs and (b) send messages.
  - For **Lark/Feishu**: the official SDK's **WebSocket long-connection client** subscribes to the `im.message.receive_v1` event, and the message API sends replies. The long connection dials *out*, so you need **no public webhook server and no tunnel**. (Slack Socket Mode, Telegram long polling, and Discord gateway give you the same "outbound connection, no inbound port" property.)
- **Node.js** (examples are Node; any language works).
- A **working directory** you want the agent to operate in (a notes folder, a project, etc.).

---

## 4. The two integration points

Abstract your chat platform behind two functions so the rest of the code is platform-agnostic:

```js
// Stream inbound direct messages. Calls onMessage({ userId, text, chatType }) per message.
function consumeMessages(onMessage) { /* ... platform SDK ... */ }

// Send a plain-text reply to a user.
function sendMessage(userId, text) { /* ... platform SDK ... */ }
```

Implement them with your platform's official SDK (or a CLI wrapper around it). For Lark/Feishu the inbound side is the long-connection event client subscribed to `im.message.receive_v1`; the outbound side is the send-message API addressed by the user's id.

> **Gotcha if you wrap a CLI that streams events on stdout:** some event-stream commands treat *stdin EOF* as "stop". If you spawn such a process with its stdin closed, it exits immediately ("context canceled"). Give the child a real stdin pipe and never close it.

---

## 5. The core: running headless Claude safely

This is the part worth copying exactly. Everything here is a security decision.

```js
import { spawn } from 'node:child_process';

const WORKDIR = process.env.BRIDGE_WORKDIR;   // e.g. ~/notes -- the only dir the agent sees

// Scrubbed env: only what claude needs. See the "auth gotcha" below for WHY this matters.
const CLEAN_ENV = {
  HOME: process.env.HOME,
  PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  TERM: 'xterm',
  LANG: process.env.LANG || 'en_US.UTF-8',
};

const ALLOWED = ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'TodoWrite'];
const DENIED  = ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];

function runClaude(prompt, sessionId) {
  const args = [
    '-p', prompt,                          // the message becomes the prompt (passed via argv, never a shell string)
    '--output-format', 'json',             // machine-readable result + session_id
    '--model', 'claude-sonnet-4-6',        // a fast model is plenty for dispatch
    '--permission-mode', 'acceptEdits',    // file edits auto-approve; OVERRIDES any global default
    '--strict-mcp-config',                 // with no --mcp-config => zero MCP servers
  ];
  if (sessionId) args.push('--resume', sessionId);
  // Put the variadic flags LAST so they don't swallow later flags:
  args.push('--allowedTools', ...ALLOWED, '--disallowedTools', ...DENIED);

  return spawn('claude', args, { cwd: WORKDIR, env: CLEAN_ENV });
}
```

**The security model, made explicit:**

- **`--permission-mode acceptEdits`** lets file edits happen without an interactive prompt (there's no human at a headless run to click "allow"), while shell/other gated tools still require approval -- which, with no prompt available, means they're **denied**. Crucially, a CLI flag **overrides** whatever default is in your global config. If your global config is set to "bypass all permissions" (common on a personal dev box), this flag is what stops the bot inheriting that. **Verify it** (see below).
- **`--disallowedTools Bash ...`** -- deny wins over allow. No shell, no network (`WebFetch`/`WebSearch`), no sub-agents (`Task`).
- **`--strict-mcp-config`** with no `--mcp-config` -- the agent loads **zero** MCP servers, so it can't reach any connected integrations.
- **`cwd: WORKDIR`** -- the working directory is the only trusted directory. File writes outside it require approval → denied. The agent is confined to that folder.
- **Pass the message via `argv`**, never by interpolating it into a shell string. No shell-injection surface.
- **Never** `--dangerously-skip-permissions` / "bypassPermissions".

**Prove the lockdown actually holds** (do this once): DM the bot `create a file test.txt with "ok", then run the shell command 'id' and tell me if it was allowed or blocked`. A correct setup writes the file **and** reports the shell command was blocked. If it returns your username, your permission flags aren't taking effect -- stop and fix that before going further.

The reply you send back is `JSON.parse(stdout).result`; the same JSON carries `session_id` (next section) and a `total_cost_usd` estimate (informational only -- on a subscription it's not a charge; usage counts against your plan limits).

---

## 6. Session continuity

Keep a per-user map of `userId → session_id` so conversations remember context.

```js
// on each message:
const prior = sessions[userId];                 // may be undefined
const child = runClaude(text, prior);           // --resume prior if present
// after it finishes:
const out = JSON.parse(stdout);
sessions[userId] = out.session_id;              // persist to a small JSON file
sendMessage(userId, out.result);
```

Add a reset command: if the message is exactly `/new`, delete `sessions[userId]` and reply "started fresh". Persist the map to disk so threads survive restarts.

---

## 7. Make it permanent (macOS launchd)

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
    <key>PATH</key>            <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>  <string>/Users/you/scripts/chat-bridge/bridge.log</string>
  <key>StandardErrorPath</key><string>/Users/you/scripts/chat-bridge/bridge.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.chat-bridge.plist
launchctl print  gui/$(id -u)/com.example.chat-bridge | grep -E 'state|pid'
```

Test KeepAlive: `kill -9 <pid>` and confirm a new pid appears. Reload after code edits with `launchctl kickstart -k gui/$(id -u)/com.example.chat-bridge` -- **but see gotcha #4**, that's not always enough.

---

## 8. Adding a privileged capability without opening a shell

Eventually you'll want the bot to *do* something that genuinely needs a shell + network -- e.g. transcribe a video link (download with `yt-dlp`, extract audio with `ffmpeg`, run a local Whisper model). You do **not** want to hand the LLM a general Bash to achieve that.

The pattern: a **scoped dispatcher**.

```js
function onMessage({ userId, text }) {
  if (/(?:some-video-host)\.com/.test(text)) return handlePrivileged(userId, text);
  return handleChat(userId, text);     // the 100% files-only path from section 5
}
```

`handlePrivileged` runs a **fixed pipeline script** -- one you wrote, that the model cannot modify or parameterize beyond a vetted input (the URL). The LLM is still only used afterward, on the *files-only* path, to clean up / save the result. Keep this path narrow and document it.

Two launchd-specific gotchas bit me here, both below (#5 and #6).

---

## 9. The gotchas that will bite you (the gold)

These are the failures that don't show up until you run under launchd on a fresh machine. The single root cause behind most of my "weird" symptoms was **macOS TCC** -- read #3 carefully.

**1. Scrub the environment, or headless `claude` says "Not logged in".**
If you spawn `claude -p` from inside another agent/automation context, it can inherit env vars (a gateway base URL, OAuth-helper vars) that redirect it to an endpoint it has no token for → "Not logged in / run /login". Fix: pass a **minimal** env (`HOME`, `PATH`, `TERM`, `LANG`) and nothing else. A launchd job is clean by default, but scrub explicitly anyway so it's robust everywhere.

**2. Keep the inbound stream's stdin open.** (See section 4.) An unbounded event-stream child that reads stdin will exit on EOF if you hand it a closed stdin.

**3. macOS TCC / Full Disk Access is per-binary, per-machine, and does NOT migrate or sync. This is the big one.**
Folders like `~/Documents`, `~/Desktop`, `~/Downloads`, and `~/Library/CloudStorage` (iCloud/Drive) are TCC-protected. **A launchd agent does not inherit the privacy grant your Terminal has.** So a job that works perfectly when you run it by hand will *silently* fail to read/write those folders under launchd -- no crash, just "operation not permitted" or an empty result.

You must grant **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) to the **launch binary itself** -- e.g. `/usr/local/bin/node`, `/bin/bash`, `/usr/bin/python3` -- not to your script. And you must re-do it on every machine; grants don't travel with a migration or a synced dotfile.

This one root cause masqueraded as, in order: a `bash: Interrupted system call` (EINTR), an 8-minute "hang", a CoreML "failed to open model file" error, and a silent "the file I asked it to write never appeared". **When a launchd job behaves bizarrely around protected folders, suspect TCC first** and stop chasing the surface symptom.

*The diagnostic that cracks it:* run the same file operation two ways -- a throwaway launchd agent vs. an interactive shell. If interactive succeeds and launchd gets "operation not permitted", that delta **is** the TCC signature.

**4. After granting Full Disk Access, fully re-bootstrap the job -- `kickstart` is not enough.**
A job that was loaded *before* the grant may keep its stale, pre-grant registration even after `kickstart -k`. Do a full re-register:

```bash
launchctl bootout   gui/$(id -u)/com.example.chat-bridge
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.chat-bridge.plist
```

**5. Under launchd, run shell scripts as in-memory `bash -c`, not as a file argument.**
macOS ships an old `/bin/bash` (3.2). Reading a script *file* incrementally under launchd can have its `read()` interrupted and not restarted (EINTR), deterministically. Pass the script body as an in-memory program instead:

```js
import { readFileSync } from 'node:fs';
spawn('/bin/bash', ['-c', readFileSync('pipeline.sh', 'utf8'), 'pipeline', input],
      { detached: true /* own process group so timeouts can kill the whole tree */ });
```

(Also remember launchd's PATH is minimal -- prepend `/opt/homebrew/bin` if your tools live there.)

**6. Measure before blaming "background throttling".**
A task that felt slow under launchd looked like QoS throttling. Measured: ~150s interactive vs ~146s under launchd -- **no throttling**. The real issue was a too-tight timeout for a task with normal variance. Give long tasks a realistic, dedicated timeout before reaching for exotic explanations.

---

## 10. Security checklist

- [ ] Bot only answers **your own user id**, in **direct messages**, **plain text** only.
- [ ] Per-message length cap; ignore non-text messages.
- [ ] `--permission-mode acceptEdits` (or stricter) -- **verified** it overrides any global "bypass" default.
- [ ] Tool allowlist + denylist; **no Bash** on the general path.
- [ ] `--strict-mcp-config` -- no MCP servers exposed.
- [ ] Working directory pinned; no `--add-dir` you didn't intend.
- [ ] Scrubbed env; message passed via argv (no shell string).
- [ ] Per-call timeout; one *audited, fixed-script* privileged path at most.
- [ ] Ran the "write a file + try to run a shell command" proof and confirmed the shell was blocked.

---

## 11. Adapting to other stacks

- **Other chat apps:** Slack (Socket Mode), Telegram (long polling), Discord (gateway) all give you the same outbound-connection-no-inbound-port model. Reimplement the two functions from section 4; everything else is unchanged.
- **Linux / systemd** instead of launchd: there's no TCC, so gotchas #3/#4 disappear -- but you still must set `WorkingDirectory`, a clean `Environment=`, and `Restart=always`, and make sure the service user can reach your credentials.
- **API key instead of a subscription:** set `ANTHROPIC_API_KEY` in the service env and skip the OAuth gotcha; just remember it now bills per token.

---

## 12. Cost / billing note

On a subscription, the `total_cost_usd` figure in `claude -p`'s JSON output is an **estimate, not a charge** -- usage counts against your plan's limits, shared with your interactive Claude Code and web usage. A chatty bot eats the same budget as your real work, so pick a fast model for dispatch and use a "new conversation" reset to keep threads short.

---

## License

[MIT](LICENSE).

*Built and battle-tested on an always-on Mac. The hard part isn't the 200 lines of glue -- it's the launchd + TCC interaction in section 9. Get Full Disk Access right and the rest just works.*
