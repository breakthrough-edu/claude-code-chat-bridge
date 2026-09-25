# Build Your Own Chat-to-Claude-Code Bridge

*Drive a headless Claude Code agent from a chat app (Lark/Feishu as the example), safely, on an always-on machine.*

Written against Claude Code 2.1.240 (September 2026). On another version, run `scripts/probe-claude.sh` first.

> ⚠️ **This agent is driven by inbound chat messages: treat every message as untrusted input.** Read [§5 The core](#5-the-core-running-headless-claude-safely) and [CHECKLIST.md](CHECKLIST.md) **before** you run anything. The security rails are not optional.

DM a bot from your phone ("summarize my latest note", "draft a file about X", "what's in this folder?") and a real Claude Code agent runs the request on your desktop and replies in the chat. It's like SSHing in to run Claude, but as casual as texting.

This is **not** a chatbot framework. It is glue around a small chat interface plus one hardened `claude -p` invocation: a reference implementation you can run (`bridge/`, about 1,600 lines of code without comments or tests, a third of it the approval card), and the non-obvious failures that are hard to diagnose unless you know to look for them ([docs/gotchas.md](docs/gotchas.md)).

What changed between versions: [CHANGELOG.md](CHANGELOG.md).

---

## 1. What you'll build

```
   Your phone / chat client
        │  (you DM a bot)
        ▼
   Chat cloud (Lark / Slack / Telegram / ...)
        │  (long-connection push: no public webhook needed)
        ▼
   bridge service  ──►  receive message
   (always-on box)      filter (you only, DM only, text only)
                        │
                        ▼
                   claude -p  (headless, caged, working dir = your folder)
                        │  streams what it is doing
                        ▼
                   progress card  ──►  updated in place, with a Stop button
                        │
                        ▼
                   send reply  ──►  back into the chat
```

Three moving parts: an **inbound stream**, a **hardened Claude run**, an **outbound send**. Everything else is polish (session memory, progress, auto-restart, one privileged path behind an approval card).

What is in the repo:

- `bridge/`: the reference implementation, with an offline test suite that runs the whole loop against a fake `claude` and a fake chat platform.
- `scripts/`: a clean-env login and cage probe, a finder for your own chat id (`whoami.sh`), pause and resume for a launchd worker, a dated backup, a transcript replay for tuning the watchdog.
- `docs/`: one chapter per topic ([map in §9](#9-map-of-the-docs)).
- `EIGHT-CELLS.md`: the worksheet you fill before you build. `CHECKLIST.md`: every checklist line in one place.

---

## 2. Design principles (why it's built this way)

1. **Thin glue, not a framework.** The whole job is *receive → run claude → reply*. A heavyweight bot platform around a three-step pipe adds a web service, more config and more attack surface. (If you would rather adopt something ready-made, [docs/build-or-adopt.md](docs/build-or-adopt.md) compares the mature options.)
2. **A hard security rail.** The agent is driven by *inbound messages*. Treat every message as untrusted input. The agent gets **no shell**, a pinned working directory, a closed tool set, and **never** "bypass permissions" mode.
3. **Verify the cage from the runtime, never from the model.** "The model says it has no shell" is not evidence. The CLI reports exactly which tools it loaded; check that list on every run (§5).
4. **Use your existing subscription.** Headless `claude -p` authenticates with the same login as interactive Claude Code. No separate API key or billing path required.
5. **One idea for real power: a fixed script, and a card when it reaches past you.** When you need something the cage forbids (a shell pipeline, a write outside the folder), code you wrote does it, and the model can only choose and draft. If the effect is visible to others, touches money, cannot be undone, or carries values the model wrote, a person taps an approval card that shows exactly what will run, and the program executes that pinned content ([docs/privileged-path.md](docs/privileged-path.md)).
6. **Silence is a bug.** A bot that goes quiet for ten minutes is indistinguishable from a dead one. Show progress, acknowledge queued messages, and say plainly when something was stopped ([docs/runs.md](docs/runs.md)).
7. **Fill the eight cells before you build.** Eight questions every unattended worker answers up front; a cell you cannot fill is a hole you name, not a blank (§7).

---

## 3. Prerequisites

- An **always-on machine**. This guide uses macOS; Linux notes are in [docs/other-stacks-and-cost.md](docs/other-stacks-and-cost.md).
- **Node.js 20.6 or newer** (`node --version`): the foreground run loads its config with `node --env-file`, and the tests use the built-in `node --test` runner. The suite is run on Node 24; on an older Node, run `npm test` before anything else.
- **Claude Code** installed and logged in. Note its absolute path: `which -a claude`, the line that starts with `/`.
- A **chat platform with a bot** that can (a) stream inbound DMs and (b) send and update messages.
  - For **Lark/Feishu**: subscribe to `im.message.receive_v1` over the **WebSocket long connection**, and send replies through the message API. The long connection dials *out*, so you need **no public webhook server and no tunnel**. (Slack Socket Mode, Telegram long polling and the Discord gateway give you the same "outbound connection, no inbound port" property.)
  - The reference `bridge/platform-lark.mjs` drives `lark-cli` (npm package `@larksuite/cli`), a command-line wrapper around that long connection and the send API. Installing it, creating the bot app and finding your ids: [docs/lark-setup.md](docs/lark-setup.md). Any SDK that does the same works; only that one file changes.
- A **working directory** you want the agent to operate in (a notes folder, a project).

---

## 4. The integration points

Abstract your chat platform behind a small interface so the rest of the code is platform-agnostic. Two functions carry messages; three more carry cards (the progress card, the Stop button, the approval card). The contract, with types, is `bridge/platform.mjs`:

```js
consumeMessages(onMessage, { onState, onFatal }) // stream inbound: { eventId, userId, chatId, chatType, messageType, text, mentions }
sendMessage(target, text, { idempotencyKey }) // markdown text to { chatId } or { userId }
sendCard(target, card, { idempotencyKey })    // returns { cardId }
updateCard(cardId, card)                      // re-render the whole card
onCardAction(handler, { onState, onFatal })   // button taps: { eventId, operatorId, value, ... }
```

`onState` reports each listener's health to the heartbeat; `onFatal` is called once when a restart cannot help (a disabled app, for example), so the bridge exits non-zero instead of retrying forever. The Lark implementation is `bridge/platform-lark.mjs`; an in-memory one for tests is `bridge/test/fake-platform.mjs`. Three things to build in from day one:

- **Dedupe on the message id, and persist it.** Keep the ids you have handled **on disk**, marked handled before you act: an in-memory set is empty after every restart, which is exactly when a redelivery is most likely. On Lark, key on `message_id`, not `event_id`: the same message can arrive again under a new `event_id` ([gotcha #21](docs/gotchas.md)). What a rerun may and may not do is the Identity cell: [docs/identity.md](docs/identity.md).
- **Send markdown, not plain text, and neutralise image links.** Models write markdown; as plain text, `**bold**` and backticks arrive as literal symbols. But a markdown send that resolves image URLs lets the model make your machine fetch an address it chose ([gotcha #20](docs/gotchas.md)).
- **Keep the inbound stream's stdin open** if you wrap a CLI that streams events on stdout. Some event-stream commands treat *stdin EOF* as "stop"; spawned with a closed stdin, they exit immediately ("context canceled"). Give the child a real stdin pipe and never close it.

> **Lark long connections do not replay missed events.** Anything sent while nothing was listening is simply gone; start the listener, wait for its ready line, then send ([docs/lark-setup.md](docs/lark-setup.md#4-events-are-not-replayed-start-listening-before-you-send)). So "the bot didn't react" almost always means "the listener wasn't running", not a configuration problem. Check that first.

---

## 5. The core: running headless Claude safely

This is the part worth copying exactly. Everything here is a security decision. Flags change between versions, so re-run the proof at the end of this section after every upgrade. Below is an abridged version; **the full version is [`bridge/run-claude.mjs`](bridge/run-claude.mjs)**, and the file is the truth if the two ever disagree.

```js
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

// bridge.mjs reads these from the environment and passes them in.
const WORKDIR = process.env.BRIDGE_WORKDIR;   // the only directory the agent works in
const CLAUDE_BIN = process.env.CLAUDE_BIN;    // absolute path: `which -a claude`, the line that starts with /

// The ONLY tools the agent gets. Glob and Grep are its file search, since it has no shell.
const WANTED = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const WANTED_MODE = 'acceptEdits';

// Scrubbed env: only what claude needs. USER and SHELL are NOT optional (gotcha #1).
function cleanEnv(parent = process.env) {
  return {
    HOME:  parent.HOME,
    USER:  parent.USER || userInfo().username,
    SHELL: '/bin/zsh',
    PATH:  '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    TERM:  'xterm',
    LANG:  parent.LANG || 'en_US.UTF-8',
  };
}

function buildArgs(prompt, sessionId, { model } = {}) {
  const args = [
    '-p', prompt,                           // the message becomes the prompt (argv, never a shell string)
    '--output-format', 'stream-json',       // one JSON event per line: progress + final result
    '--verbose',                            // required by stream-json in print mode
    '--include-partial-messages',           // stream text as it is written (keeps the watchdog fed)
    '--permission-mode', WANTED_MODE,       // file edits auto-approve; OVERRIDES any global default
    '--strict-mcp-config',                  // with no --mcp-config: zero MCP servers
    '--tools', WANTED.join(','),            // the real allowlist: nothing outside this list is loaded
  ];
  if (model) args.push('--model', model);   // the bridge passes BRIDGE_MODEL, default claude-sonnet-5
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

const child = spawn(CLAUDE_BIN, buildArgs(prompt, sessionId, { model }), {
  cwd: WORKDIR,
  env: cleanEnv(),
  detached: true,                           // own process group, so a stop reaches everything it started
  stdio: ['ignore', 'pipe', 'pipe'],        // the prompt is in argv; nothing is read from stdin
});
```

**The security model, made explicit:**

- **`--permission-mode acceptEdits`** lets file edits happen without an interactive prompt (there is no human at a headless run to click "allow"), while other gated actions still require approval, which, with no prompt available, means they are **denied**. A CLI flag **overrides** the permission default in your global config, so a permissive default on your own machine does not leak into the bot.
- **`--tools` is the allowlist. `--allowedTools` is not.** `--tools Read,Edit,Write,Glob,Grep` loads exactly those five tools: on 2.1.240 the init event lists exactly those five, and `scripts/probe-claude.sh` shows what yours lists. `--allowedTools` only pre-approves tools and does not unload the rest: on 2.1.240, `--allowedTools Read` still loads over twenty tools, `Bash` among them ([gotcha #10](docs/gotchas.md)). If your CLI build has no `--tools`, fall back to `--disallowedTools` listing everything else the init event shows, and expect to maintain that list.
- **`--strict-mcp-config`** with no `--mcp-config`: the agent loads **zero** MCP servers, so it cannot reach any connected integrations.
- **`cwd: WORKDIR`**: the working directory is the trusted directory. Reads and writes outside it require approval, so they are denied. On 2.1.240, reading `/etc/hosts` is denied, a `Write` to a path outside the working directory is denied, and so is writing `.claude/settings.local.json` inside it ([docs/proof.md](docs/proof.md#the-probes-with-what-you-should-see) checks these on yours). That last one matters: the file can define hooks, and hooks run shell commands in every later session.
- **Pass the message via `argv`**, never by interpolating it into a shell string. No shell-injection surface.
- **Spawn `claude` by absolute path.** Node looks the command up in the *child's* PATH, which you just scrubbed. Depending on how you installed Claude Code it lives in `~/.local/bin`, an npm prefix folder or Homebrew, and a bare `'claude'` fails with `spawn claude ENOENT`.
- **Never** `--dangerously-skip-permissions`, and never `bypassPermissions`.
- **Your global `~/.claude/settings.json` still applies**, hooks included ([gotchas #4 and #11](docs/gotchas.md)). Know what is in it.

### Check the cage on every run

Early in the stream there is one event of type `system`, subtype `init`. It carries `tools` (what this run actually loaded) and `permissionMode` (the mode actually in force). ⚠️ It is **not** necessarily the first line: with hooks installed, `system/hook_*` events can come before it. Find it by type:

```js
// Returns null when the cage holds, or a description of the breach.
function checkCage(ev) {
  const loaded = [...(ev.tools || [])].sort().join(',');
  const wanted = [...WANTED].sort().join(',');
  if (loaded !== wanted || ev.permissionMode !== WANTED_MODE) {
    return { loaded, wanted, permissionMode: ev.permissionMode };
  }
  return null;
}

// For every parsed stream-json line:
if (ev.type === 'system' && ev.subtype === 'init') {
  const breach = checkCage(ev);
  if (breach) { log('CAGE BREACH:', breach); stop('cage'); return; }   // kill the group, tell the chat why
  log(`cage ok: tools=${[...ev.tools].sort().join(',')} mode=${ev.permissionMode}`);
}
```

This is cheap, and it catches the two failures that matter: a CLI update that changes what `--tools` loads, and a permissive global default leaking in because a flag was dropped. The reference also treats a run that produces a result **without** any init event as a breach: a cage that was never checked is not a cage.

**Prove the lockdown actually holds** (once, and after every CLI upgrade). The proof is the bridge log, never the model's reply: a model that says "I have no shell" may just be repeating your instructions back to you, and a refusal proves nothing about the cage. Every check below can fail:

- **No shell.** Every run logs `cage ok: tools=Edit,Glob,Grep,Read,Write mode=acceptEdits`. No `Bash` in that list means the run could not start a shell, whatever the reply says. `scripts/probe-claude.sh` must print `cage: MATCH` for the same reason.
- **Reads outside are blocked.** DM `use the Read tool on /etc/hosts and show me the first line`. The log must show `denied: Read /etc/hosts`, and the reply must hold no file contents. A refusal with no `denied:` line is **not** a pass: the model never tried, so the wall was never tested. Ask again, more directly.
- **Writes inside work.** DM `create a file test.txt with "ok"` and check outside the chat that the file exists with that content.

More probes, with what you should see: [docs/proof.md](docs/proof.md#the-probes-with-what-you-should-see).

The final event is `{"type":"result", ...}`: its `result` is the reply text, it carries `session_id` (for `--resume`) and `permission_denials` (the bridge logs each one as `denied: <tool> <input>`; they show what the cage stopped), plus a `total_cost_usd` estimate (informational only: on a subscription it is not a charge; see [docs/other-stacks-and-cost.md](docs/other-stacks-and-cost.md)). Store a session id only from a successful run, and retry once without `--resume` when a stored one is dead ([docs/sessions-and-groups.md](docs/sessions-and-groups.md)). Stopping a run kills the whole process group ([docs/runs.md](docs/runs.md#stopping-must-kill-the-whole-tree)).

---

## 6. Quick start

Each step says what you should see. Where a step is not covered by the offline suite, it says how to check it on your setup.

**1. Clone outside the protected folders.** launchd cannot start a job from `~/Documents`, `~/Desktop` or `~/Downloads` after a cold boot ([docs/launchd.md](docs/launchd.md#a-plist-that-points-into-documents-works-until-the-first-cold-boot)), and the plist template expects `~/Scripts/chat-bridge`:

```bash
git clone <this repo's URL> ~/Scripts/chat-bridge
cd ~/Scripts/chat-bridge
```

**2. Run the offline suite.** No network, no login, no chat app: a fake `claude` and a fake platform drive the whole loop (normal run, silent hang, cage breach, dead resume, crash and restart, Stop, approval cards).

```bash
npm test          # expect: every test passes, "fail 0" at the end
npm run check     # expect: no output from the syntax checks, then "OK" from plutil for the plist
```

**3. Probe the real CLI** from a normal terminal. Not over SSH, and not from inside another agent's sandboxed shell: both give a false login error ("Not logged in" or "OAuth session expired") while your login is fine.

```bash
scripts/probe-claude.sh "$(which -a claude | grep '^/' | head -1)"
```

Expect `init tools: Edit,Glob,Grep,Read,Write`, `init permissionMode: acceptEdits`, `cage: MATCH`, `result is_error: false`, and exit 0. Exit 1 is a cage mismatch: do not go on. Exit 2 means the path was not absolute. Exit 3 prints a diagnosis that separates an environment problem from a real login problem.

**4. Fill the eight cells.** Copy [`EIGHT-CELLS.md`](EIGHT-CELLS.md) next to your code and answer every cell for the bridge you are about to run; a cell you cannot fill reads `hole: <why>`. The reference bridge's own filled sheet, holes included, is [`examples/eight-cells-bridge.md`](examples/eight-cells-bridge.md).

**5. Set up the Lark app and find your id.** Follow [docs/lark-setup.md](docs/lark-setup.md) sections 1 to 5: install `lark-cli`, create the bot app as its own named profile, add the card callback through the launcher link the card listener prints, and run `scripts/whoami.sh <profile>` to get your own `open_id` under **this** app (and the chat id of your DM with the bot). That chapter is the one source for console steps; it also covers the errors you may meet.

**6. Write the config.** The same variables serve the foreground run and the plist; the full list, with comments, is `bridge/example.env` and the header of `bridge/bridge.mjs`.

```bash
cp bridge/example.env bridge/.env     # git-ignored; edit every placeholder
```

| Variable | Required | What |
|---|---|---|
| `BRIDGE_WORKDIR` | yes | the only directory the agent works in (absolute path) |
| `CLAUDE_BIN` | yes | absolute path to `claude` |
| `BRIDGE_ALLOWED_USERS` | yes | comma-separated sender ids: the `sender_id` that `scripts/whoami.sh` printed. Only these may send or tap. Empty means the bridge refuses to start |
| `LARK_CLI`, `LARK_PROFILE` | for Lark | absolute path to `lark-cli`; the profile of this bot app. Run one consumer per app: two split its events ([lark-setup.md](docs/lark-setup.md#4-events-are-not-replayed-start-listening-before-you-send), unverified on your setup) |
| `BRIDGE_BOT_ID` | no | the bot's own id, for @-mentions in groups ([lark-setup.md](docs/lark-setup.md#5-find-your-own-id-and-the-bots)); leave it out and groups are ignored |
| `BRIDGE_STATE_DIR` | no | ledger, sessions, heartbeat; default `./state` |
| `BRIDGE_MODEL` | no | default `claude-sonnet-5` |
| `BRIDGE_IDLE_MS`, `BRIDGE_HARD_CAP_MS` | no | silence watchdog (5 min) and hard cap (45 min) |
| `BRIDGE_HEARTBEAT_URL` | no | outside ping for a dead-man's switch; off if unset ([docs/heartbeat.md](docs/heartbeat.md)) |
| `BRIDGE_OUTSIDE_DIR` | no | turns on the one approval-card action; a folder **outside** the working directory ([docs/approval-card.md](docs/approval-card.md)) |

**7. Run it in the foreground and prove it from the log.**

```bash
node --env-file=bridge/.env bridge/bridge.mjs
```

Expect a line like `bridge started; 1 allowed sender(s); groups off`, and a `[event] ready` line for each listener. Then DM the bot (from the Lark client, or from a terminal as in [lark-setup.md §7](docs/lark-setup.md#7-testing-without-a-phone)). What counts as proof is the log, not the chat:

- `cage ok: tools=Edit,Glob,Grep,Read,Write mode=acceptEdits` for the run;
- `job <id> done in <N>s; reply sent` when it finishes. `reply NOT confirmed sent` means the run finished but the send did not confirm: check the chat before you resend. No `job` line at all means the bridge never took the message: check the allowlist and that the listener was ready before you sent.

Then run the lockdown checks from §5 (`denied: Read /etc/hosts` must appear), and send `/new` (expect "Started fresh."). In the client, the progress card should update in place and end with no Stop button. Stop with Ctrl-C. Unverified on your setup until this step passes.

**8. Install it as a LaunchAgent.** Copy `bridge/com.example.chat-bridge.plist` to `~/Library/LaunchAgents/`, put in the values from your `bridge/.env`, replace every `YOUR_USER` and `ou_xxx`, and leave `BRIDGE_BOT_ID` commented out unless you want groups ([lark-setup.md §5](docs/lark-setup.md#5-find-your-own-id-and-the-bots) says how to find the bot's id). The plist's `PATH` must include the folder `node` lives in, because `lark-cli` is itself a node script ([lark-setup.md §1](docs/lark-setup.md#1-install-lark-cli)). Then follow the three commands in the plist's header (`mkdir` the logs folder, `plutil -lint`, `launchctl bootstrap`). Check with `launchctl print gui/$(id -u)/com.example.chat-bridge | grep -E 'state|pid|last exit'`. Details, Full Disk Access and the cold-boot trap: [docs/launchd.md](docs/launchd.md).

**9. Test stop-for-good.** Stopping a run is not stopping the worker, and `launchctl bootout` alone comes back at the next login.

```bash
scripts/pause.sh com.example.chat-bridge       # bootout + move the plist out of LaunchAgents
ls ~/Library/LaunchAgents | grep -F com.example.chat-bridge   # expect: nothing
```

Log out and back in (or reboot) and check again, then bring it back with `scripts/resume.sh com.example.chat-bridge`. Unverified on your setup until you have done the re-login step; the full stop test is in [CHECKLIST.md](CHECKLIST.md#the-stop-test).

---

## 7. The eight cells

Every worker that runs while you are not watching answers eight questions **before it is built**. A cell you cannot fill is the first thing to fix; if you cannot fix it yet, write `hole: <why>` and keep it visible. Identity and Heartbeat are there because their failures are silent: a double write and a worker that never ran produce no errors. The method: [docs/eight-cells.md](docs/eight-cells.md). The worksheet: [EIGHT-CELLS.md](EIGHT-CELLS.md).

| # | Cell | The question | Where it lives | Chapter |
|---|---|---|---|---|
| 1 | Reads | What it reads, and nothing else. | `cwd`, `--tools`, the cage check | [§5](#5-the-core-running-headless-claude-safely) |
| 2 | Writes | What it can change or send. "Never writes" is a legal answer. | `acceptEdits` inside the working directory; decides whether a card is needed | [approval-card.md](docs/approval-card.md) |
| 3 | Identity | For every write that leaves the box: the stable id (never a filename), and what happens if it runs twice. | `bridge/ledger.mjs` | [identity.md](docs/identity.md) |
| 4 | Limits | Timeouts, retries, maximum sends per run, per-sender rate. | `LIMITS` in `bridge/loop.mjs` | [runs.md](docs/runs.md#limits-put-a-number-on-everything-that-can-run-away) |
| 5 | Stop | The one line that stops it; what half-done work it leaves; whether it comes back after a reboot or re-login. | process group kill, `scripts/pause.sh`, the stop test | [launchd.md](docs/launchd.md#stop-it-for-good) |
| 6 | Proof | How you know it worked, other than exit 0 or the model saying so. | cage check, `permission_denials`, read-back, `scripts/probe-claude.sh` | [proof.md](docs/proof.md) |
| 7 | Heartbeat | If it stops running, or the whole machine goes, who outside the machine notices, and within how long. | `bridge/heartbeat.mjs` | [heartbeat.md](docs/heartbeat.md) |
| 8 | Rollback | Which backup to put back, which records to delete, and what "current version" means. | `scripts/backup.sh` | [rollback.md](docs/rollback.md) |

---

## 8. The approval card

Read your Writes and Rollback cells against four tests. **Any one true means that action goes through a card:**

1. Someone other than you can see the result.
2. It touches real money or a ledger.
3. It cannot be undone.
4. The value being written was generated by the model.

The card shows the exact target and the full content, "not yet written", and buttons that carry the draft id and a content fingerprint. On a tap, **the program executes exactly the pinned draft; the model is not asked again.** The claim is single-use, every failure returns the draft to pending, and success is marked only after a read-back. The reference ships one carded action (write a file outside the working directory), off unless `BRIDGE_OUTSIDE_DIR` is set; the offline suite covers taps, double taps, expiry and failures, but not how a real client renders the card. Unverified on your setup: a person taps one real card on a test app (no command can press the button for you), as in [docs/approval-card.md](docs/approval-card.md#verifying-it).

---

## 9. Map of the docs

| File | What it covers |
|---|---|
| [docs/lark-setup.md](docs/lark-setup.md) | Lark from nothing: install `lark-cli`, create the app as a profile, the card callback, `scripts/whoami.sh` for your ids, the foreground run, testing without a phone, error 20069. |
| [docs/eight-cells.md](docs/eight-cells.md) | The contract: each cell's question, why it exists, good answers and holes. |
| [docs/proof.md](docs/proof.md) | Ask the runtime, never the model: the probes and what you should see, the "it refused" trap, proof of a write is a read-back. |
| [docs/identity.md](docs/identity.md) | Persisted message ids, the job ledger, why a `running` job is never rerun after a restart, stable ids for outbound writes. |
| [docs/runs.md](docs/runs.md) | Progress card, the Stop button, killing the whole tree, slow vs stuck, and every limit as a named constant. |
| [docs/sessions-and-groups.md](docs/sessions-and-groups.md) | Session continuity and the dead-resume retry; answering in groups without widening who can drive the bot. |
| [docs/launchd.md](docs/launchd.md) | Installing the LaunchAgent, Full Disk Access, the cold-boot trap, three kinds of stop, stop for good, resume. |
| [docs/heartbeat.md](docs/heartbeat.md) | Three layers (state file, same-machine watcher, outside the machine) and the honest answer when you have no third. |
| [docs/rollback.md](docs/rollback.md) | Dated backups with md5, "current version = after which backup", restoring, published copies that do not resync. |
| [docs/approval-card.md](docs/approval-card.md) | The four tests, the pinned card, the tap sequence, the example action, limits, live verification, the reverse check. |
| [docs/privileged-path.md](docs/privileged-path.md) | One real power without a shell: the scoped dispatcher, and why it and the card are one idea. |
| [docs/gotchas.md](docs/gotchas.md) | Twenty-four numbered failures: launchd, TCC, login, hooks, parsers, dates, image links, dedupe keys, a disabled Lark app. |
| [docs/build-or-adopt.md](docs/build-or-adopt.md) | Maintained alternatives, and the traps to check in any mid-turn approval relay. |
| [docs/other-stacks-and-cost.md](docs/other-stacks-and-cost.md) | Other chat apps, Linux, an API key; where the tokens go in a headless run. |
| [EIGHT-CELLS.md](EIGHT-CELLS.md) · [examples/eight-cells-bridge.md](examples/eight-cells-bridge.md) | The worksheet, and the reference bridge's own filled sheet. |
| [CHECKLIST.md](CHECKLIST.md) | Every checklist line from every chapter, grouped by when you tick it. |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and what to redo if you built from an older version. |

Code: `bridge/bridge.mjs` (entry point, config from env) with `bridge/example.env`, `bridge/loop.mjs` (filters, queue, jobs, `LIMITS`), `bridge/run-claude.mjs` (§5), `bridge/idle-watch.mjs`, `bridge/ledger.mjs`, `bridge/sessions.mjs`, `bridge/heartbeat.mjs`, `bridge/approval.mjs` with `bridge/actions/write-outside.mjs`, `bridge/platform.mjs` (the interface) and `bridge/platform-lark.mjs`, `bridge/com.example.chat-bridge.plist`, tests in `bridge/test/`. Scripts: `scripts/probe-claude.sh` (clean-env login and cage probe), `scripts/whoami.sh` (your sender id, chat id and the bot's id under one app), `scripts/pause.sh` and `scripts/resume.sh` (stop a launchd worker for good, and undo it), `scripts/backup.sh` (dated backup with md5), `scripts/replay-transcripts.mjs` (watchdog numbers from your own transcripts). Load-check a file with `node --check`, never by importing `bridge.mjs`: that starts a second consumer ([gotcha #15](docs/gotchas.md)).

---

## 10. The short checklist

The ten lines that matter most. Everything else, grouped by when you tick it, is in [CHECKLIST.md](CHECKLIST.md).

- [ ] Eight cells filled before building, holes named; every action that passes an approval-card test has a card.
- [ ] Bot answers only your own user id; in groups, only when @-mentioned, enforced in code.
- [ ] `--permission-mode acceptEdits` and `--tools` with exactly the tools you want, on the command line; never `bypassPermissions`.
- [ ] Every run checks the `system/init` event, and a mismatch stops the run as a **CAGE BREACH**.
- [ ] Lockdown proved from the log, never the reply, after every CLI upgrade: `cage ok:` with no `Bash` in `tools=`, and `denied: Read /etc/hosts` for a request to read it.
- [ ] Scrubbed env that still includes `USER` and `SHELL`; message passed via argv; `claude` spawned by absolute path.
- [ ] Handled message ids persisted on disk; a job found `running` or `replying` after a restart is never rerun.
- [ ] Child spawned `detached`; stops kill the process group; silence watchdog plus hard cap; the chat is told.
- [ ] Nothing launchd opens lives under `~/Documents`, `~/Desktop` or `~/Downloads`; the stop test survived a re-login.
- [ ] Heartbeat cell names who outside the machine notices (or says a dead machine is invisible); a dated backup with its md5 exists before every change.

---

## License

[MIT](LICENSE).

*The hard part isn't the glue. It's the launchd and privacy interaction, proving the cage from the runtime, and filling the eight cells before you build. Get those right and the rest is plumbing.*
