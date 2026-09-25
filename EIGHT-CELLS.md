# Eight cells: worksheet

*Copy this file next to your worker's code and fill it **before** you build. The method is in [docs/eight-cells.md](docs/eight-cells.md); a filled example is in [examples/eight-cells-bridge.md](examples/eight-cells-bridge.md).*

## How to fill it (for you, or for the AI filling it with you)

- Answer every cell. **A cell you cannot fill reads `hole: <why>`.** Never leave one blank, and never delete a hole to make the sheet look finished.
- Answer from the code and the running system, not from what you intend. Where you can, point to the evidence: a file and line, a command and what it printed.
- "Never writes", "not applicable" and "only on-machine" are legal answers when they are true. Say why they are true.
- Fill the silent-failure cells first: Identity, Stop, Proof, Heartbeat.
- The example answers are written in the voice of the person filling the sheet ("my DM", "alerts me"). Replace them; do not keep them.
- If you are an AI filling this for someone: do not guess at a value you cannot read from the code or a command's output. Write `hole: not found in code` and list it under "Holes" at the end, then hand the sheet back.

---

**Worker:** <name, launchd label>
**What it does, in one line:** <…>
**Runs on:** <which machine, by role, e.g. "the always-on desktop">
**Filled on:** <date> **by:** <who> **Claude Code version:** <`claude --version`>

---

## 1. Reads

**What it reads, and nothing else.**

Answer:

> Example: The notes folder in `BRIDGE_WORKDIR`, through Read, Glob and Grep only; no `--add-dir`; zero MCP servers. The bridge process reads its own state folder and DMs from my user id.

## 2. Writes

**What it can change or send. "Never writes" is a legal answer.**

Answer:

> Example: Files inside `BRIDGE_WORKDIR` (model, auto-approved). Replies and progress cards to my DM only. Never: `.claude/` inside the working directory, any other chat, anything outside the working directory without a card.

## 3. Identity

**For every write that leaves the box: the stable id (never a filename), and what happens if it runs twice. "Not applicable, never writes outside" is legal.**

Answer:

> Example: Inbound message ids (the message's own id, not the delivery or event id) persisted in the ledger. A job found `running` after a restart is not rerun; I get one line saying it was interrupted. Replies are sent with an idempotency key derived from the job id, so a retried send is dropped by the platform, not posted twice, where the platform honours the key.

## 4. Limits

**Timeouts, retries, maximum sends per run, per-sender rate.**

Answer:

> Example (the reference bridge's values, from `LIMITS` in `bridge/loop.mjs`): Silence watchdog 5 min, hard cap 45 min, send timeout 60 s, 2 send retries with backoff, at most 6 messages and cards per run, 20 messages per sender per 10 min, message length cap 4,000 characters, one job at a time (5 waiting at most) with an instant "queued" reply.

## 5. Stop

**The one line that stops it; what half-done work it leaves; whether it comes back after a reboot or re-login.**

Answer:

> Example: `scripts/pause.sh com.example.chat-bridge` (bootout, plist moved out of LaunchAgents), then pause the state-file watcher. A running job is killed with its process group and marked `stopped`; waiting jobs are marked `dropped` and their senders told. Does not come back after a reboot: after one, the plist is absent from `~/Library/LaunchAgents` and `launchctl print gui/$(id -u)/com.example.chat-bridge` finds no service.

## 6. Proof

**How you know it worked, other than exit 0 or the model saying so.**

Answer:

> Example: Every run compares the init event's `tools` and `permissionMode` to the wanted set and stops on a mismatch. Lockdown probe after every CLI upgrade, checked outside the chat. Card actions marked done only after reading the result back.

## 7. Heartbeat

**If it stops running, or the whole machine goes, who outside the machine notices, and within how long.**

Answer:

> Example: State file every 60 s; same-machine watcher every 5 min alerts me through a second bot. Hole: nothing outside the machine; a dead machine is invisible.

## 8. Rollback

**Which backup to put back, which records to delete, and what "current version" means.**

Answer:

> Example: Current version = after `bridge.mjs.bak-watchdog-<date>` (md5 noted in my notes). Restore = copy back, check md5, `/restart`, rerun the proof. Sent messages cannot be recalled. Model edits in the working directory: reversible through git.

---

## Approval card check

Read the Writes and Rollback answers against the four tests. Any one true for an action means that action goes through an [approval card](docs/approval-card.md).

| Action | Someone else sees it? | Money or a ledger? | Cannot be undone? | Model-generated value? | Card? |
|---|---|---|---|---|---|
| <action> | | | | | |

> Example row: "write a file outside the working directory" · no · no · no · yes (the content) · **yes**.

## Holes

Every `hole:` above, one line each, with what would close it and whether you accept it for now.

- <cell>: <hole> · <what would close it> · <accepted / to fix>
