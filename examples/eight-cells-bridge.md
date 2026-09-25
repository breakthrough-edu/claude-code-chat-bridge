# Eight cells: the reference bridge in this repo

*The `bridge/` implementation's own worksheet, filled in honestly. Holes are named, not hidden. Use it as a model for your own copy of [`EIGHT-CELLS.md`](../EIGHT-CELLS.md), not as a description of your bridge: the moment you change the code, your answers change too.*

**Worker:** the chat bridge in `bridge/` (launchd label `com.example.chat-bridge` in the docs)
**What it does, in one line:** takes text messages from allowlisted users (DMs, and group messages that @-mention it if a bot id is configured), runs a caged `claude -p` in one working directory, replies in the chat with a live progress card.
**Runs on:** one always-on macOS machine, as a user LaunchAgent.
**Filled on:** 2026-09-25, from the code as written that day, against Claude Code 2.1.240. On another version, run the probes in [docs/proof.md](../docs/proof.md) first. Where this sheet says "unverified on your setup", it also says how to verify it.

---

## 1. Reads

The working directory in `BRIDGE_WORKDIR`, through `Read`, `Glob` and `Grep` (plus `Edit` and `Write`, which read what they change). No `--add-dir`. Zero MCP servers (`--strict-mcp-config` with no config). Reads outside the working directory need approval and are denied in a headless run (§5: reading `/etc/hosts` is denied; probe 2 in [proof.md](../docs/proof.md) checks it on yours).

The bridge process itself reads: inbound messages from the platform (only text from `BRIDGE_ALLOWED_USERS` passes; in a group only when it @-mentions `BRIDGE_BOT_ID`, and without that id groups are ignored), its ledger, its session map, and its own config from the plist's environment. It does not pull earlier group messages as context.

Your global `~/.claude/settings.json` still applies to every run, hooks included. **Hole:** whatever your global settings load is outside this sheet's control. Read that file and write what it adds here.

## 2. Writes

- **Model:** files inside the working directory, auto-approved by `acceptEdits`. It cannot write `.claude/settings.local.json` inside it (§5: denied).
- **Bridge:** its own state files (ledger, session map, heartbeat state file, and the approval store `approvals.json` with the raw drafts it moved out of the outbox) and its log.
- **Chat:** replies and progress cards, only into the chat the message came from (a DM, or a group where an allowlisted sender mentioned it). Cards are repainted without buttons when a job ends.
- **One carded action:** writing a new file into a fixed folder outside the working directory (`bridge/actions/write-outside.mjs`). **The model cannot perform it:** no tool it has reaches outside the working directory. All it can do is leave a draft file in `outbox/` inside the working directory. After the run, the program (`bridge/approval.mjs`) reads the draft, pins it, and sends one card showing the exact target and the full content. On Approve, the program writes exactly that; the model is not asked again. The target folder comes from config, and the file name is the draft id, never a name the model chose. **Off unless `BRIDGE_OUTSIDE_DIR` is set** to an absolute path outside the working directory, and wired into `bridge/bridge.mjs` as shown in [approval-card.md](../docs/approval-card.md).
- **Never:** a chat no allowlisted sender wrote from; anything outside the working directory except the program executing an approved card; a shell (there is none).

Approval card check: the only action that passes a test is the write outside the working directory (test 4: the content is model-generated). It has a card. Replies to yourself need none.

## 3. Identity

- **Inbound:** the platform's message id is the dedupe key, persisted in the ledger (`bridge/ledger.mjs`) and marked handled before any work starts. A redelivery after a restart is dropped.
- **Jobs:** a job found `running` or `replying` at startup is **not** rerun; it is marked `interrupted` and the user is told (for `replying`: the reply may not have reached them). A job found `received` (never started) is marked `dropped` and the user is asked to resend.
- **Replies:** every send carries an idempotency key made from the job id and the kind of message (`<job id>:reply`, `<job id>:ack`; `bridge/loop.mjs`), so a send retried after a timeout is dropped by the platform instead of posted twice. That holds only where the platform honours the key; the Lark implementation passes it through.
- **Card action:** the draft id (made by the program, and also the file name) plus a sha256 fingerprint of everything the card shows. The claim is single-use and written to disk before anything runs, so a second tap does nothing. Check before writing: same id and same content is "already done"; same id and different content is an error, never an overwrite. Read back after. A draft left `claimed` by a crash goes back to `pending` at startup, and approving it again is recognised rather than repeated.
- **Hole:** files the model edits inside the working directory have no stable id. If you resend a request after an interruption, the model does the work again and may repeat an edit. Acceptable: the edits stay in a folder you own and can review. Close it by putting the working directory under version control.

## 4. Limits

Named constants in `LIMITS` at the top of `bridge/loop.mjs`; the file is the truth. As written on 2026-09-25:

- silence watchdog 5 min (paused while a tool is open), hard cap 45 min; both overridable from the plist (`BRIDGE_IDLE_MS`, `BRIDGE_HARD_CAP_MS`)
- send timeout 60 s; 2 retries after a failed send, backoff starting at 2 s and doubling
- at most 6 messages and cards per job; beyond that, sends are dropped and logged
- per-sender rate: 20 messages per 10 minutes; inbound message cap 4,000 characters (refused, not cut); replies cut at 8,000 characters with a note
- one job at a time, at most 5 waiting; a message that arrives mid-run gets an instant "queued" reply, and a full queue is refused out loud
- progress card updated at most once a second; on SIGTERM, 5 s for the running job to stop
- heartbeat every 60 s; outside ping timeout 10 s (`bridge/heartbeat.mjs`)
- approval card (`APPROVAL_LIMITS` in `bridge/approval.mjs`): expires after 24 h; 3 failed attempts, then it stops as `failed`; at most 3 drafts carded per run, the rest refused out loud; a draft file over 64 KB is refused unread
- carded file (`WRITE_OUTSIDE_LIMITS` in `bridge/actions/write-outside.mjs`): content at most 3,000 characters so the card can show all of it (refused, never cut); title at most 120 characters

## 5. Stop

- **Stop one run:** the Stop button on the progress card, or the watchdog, or the hard cap. Each kills the `claude` process group and forces its pipes shut. The job becomes `stopped` and the card says so.
- **Stop the bridge for good:** `scripts/pause.sh com.example.chat-bridge` (bootout, then the plist moved out of `~/Library/LaunchAgents/`). Then pause your same-machine watcher, or it will alert on the stop. `scripts/resume.sh` reverses it. See [launchd.md](../docs/launchd.md).
- **Half-done work:** on a clean stop (`bootout` sends SIGTERM), the running job's process group is killed and the job is marked `stopped`; waiting jobs are marked `dropped` and their senders told. On a crash, the job stays `running` (or `replying`, if the run had finished but the reply was not yet confirmed) and is reported as interrupted on the next start, not rerun. Either way, a run killed mid-job may already have edited files. An orphaned `claude` group from a crash is killed on startup, after checking the recorded pid still belongs to `claude`.
- **Comes back after reboot or re-login?** No, because the plist is not in LaunchAgents. **Unverified on your setup** until you run the stop test in [`CHECKLIST.md`](../CHECKLIST.md): pause, reboot (or log out and in), and check that `launchctl print gui/$(id -u)/com.example.chat-bridge` reports the service is not found and that its plist is absent from `~/Library/LaunchAgents/`.

## 6. Proof

- **Every run:** the `system/init` event's `tools` and `permissionMode` are compared to `WANTED` and `acceptEdits`; a mismatch, or a result with no init event at all, stops the run as `CAGE BREACH` (`bridge/run-claude.mjs`). A passing run logs `cage ok: tools=Edit,Glob,Grep,Read,Write mode=acceptEdits`, which is the proof there is no shell.
- **Every result:** each entry in `permission_denials` is logged as `denied: <tool> <input>`.
- **Once and after every CLI upgrade:** the lockdown probe in [proof.md](../docs/proof.md), checked outside the chat (§5).
- **Login problems:** `scripts/probe-claude.sh` from your own terminal.
- **Card action:** done only after the bytes on disk hash to the approved fingerprint; then the card is repainted as spent, with no buttons. Every failure puts the draft back to `pending` and repaints the card with its buttons and the error.
- **Replies:** proof of a send is `replyDelivered: true` in the ledger, set after `lark-cli` returns success; the log line is `job <id> <state> in <N>s; reply sent` (or `reply NOT confirmed sent`). **Hole:** that is the send call succeeding, not a read-back. The returned message id is not checked and the reply is not fetched back, so a message the platform accepted but never displayed would go unnoticed.

## 7. Heartbeat

- **Layer 1:** state file every 60 s (`bridge/heartbeat.mjs`, written to `heartbeat.json` in the state folder): timestamp, pid, current job and its deadline, `connection`, `listeners`, and whether the last outside ping succeeded. `listeners` holds the state of each of the two listeners (messages and card taps); `connection` is `listening` only when both are, `down` as soon as either is down or closed (or after a fatal listener error), `starting` in between, and `closed` after a clean shutdown.
- **Layer 2:** a same-machine watcher reading that file. **Not shipped** in this repo: you write it (a short script and its own plist). Until you do, nothing reads the state file.
- **Layer 3:** an optional outside ping to a dead-man's-switch URL (`BRIDGE_HEARTBEAT_URL`), sent only while `connection` is `listening`, so a bridge that has lost either listener goes quiet to the outside. **Off by default.** Unverified on your setup until you point it at a service, stop the bridge, and see that service's alert arrive.
- **The honest answer as shipped:** a state file only. **Hole: a dead machine is invisible, and so is a dead bridge, until you add layer 2 or 3.**

## 8. Rollback

- **Code:** before every change, `scripts/backup.sh` makes a dated `.bak-<label>-<date>` copy and prints its md5. Current version = after the last backup you took. Restore = copy back, check the md5, `/restart`, rerun the cage check. See [rollback.md](../docs/rollback.md).
- **State files:** back up the ledger and session map too when a change touches their format.
- **Records to delete:** the only outside write is the carded file. Its path is on the card and in the approval store (`approvals.json` in the state folder): each `done` draft names the file it wrote.
- **Cannot be rolled back:** messages already sent (the bridge has no recall); model edits inside the working directory, unless that folder is under version control.
- **Published copies:** the plist's environment block is a copy of your config. Changing a value elsewhere does not change what the running bridge sees until you edit the plist and re-register it. Old cards in the chat keep what they showed when they were sent. A progress card is repainted when its job ends. An approval card is repainted when it is tapped, and at startup when its draft is found expired; tapping an expired card writes nothing.

---

## Holes, in one place

| Cell | Hole | What would close it | Status |
|---|---|---|---|
| Reads | global `~/.claude/settings.json` (hooks included) applies and is not controlled here | read it; keep it minimal on the bridge machine | yours to fill |
| Identity | model edits inside the working directory have no stable id | put the working directory under version control | accepted |
| Stop | stop-for-good not yet proved by a reboot | run the stop test on a throwaway label | open |
| Proof | a reply counts as delivered when the send call succeeds; no message id check, no read-back | check the returned message id, then fetch the message back | accepted |
| Heartbeat | no watcher shipped; outside ping off; a dead machine is invisible | write the layer 2 watcher; turn on layer 3 | open |
| Rollback | sent messages cannot be recalled | none; that is why outside writes go through a card | accepted |
