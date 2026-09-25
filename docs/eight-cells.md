# The eight cells

*The contract a bridge (or any worker that runs while you are not watching) signs before it is built.*

Written 2026-09-25 against Claude Code 2.1.240. On another version, run the probes in [proof.md](proof.md) first. This chapter is a method, not code; where it states a runtime fact, the fact comes from the README's core section (§5).

---

## The rule

**Fill the eight cells before you build.** A cell you cannot fill is the first thing to fix. If you cannot fix it yet, write `hole: <why>` in that cell and keep it visible. A hole you can see is a decision; a blank cell is a surprise waiting for a date.

The point of the sheet is not to have every line filled. It is to find the line you cannot fill, while changing the design is still cheap. Filling the cells after the worker is running is backwards: by then the answers describe what you built instead of deciding it.

Why eight and not fewer: most checklists ask what a worker reads, writes, and how to stop it. Two failures slip past those questions because neither produces an error. **Identity** asks what happens when the same thing runs twice (it writes twice, quietly). **Heartbeat** asks who notices when it never runs at all (nobody, unless someone was set up to). Both cells exist for failures that are silent by nature.

**What to fill first:** the cells whose failure is silent. A worker that crashes loudly will tell you; a worker that double-writes, never really stopped, or died with its machine will not. Silent failure, not importance, sets the order.

Use the worksheet: [`EIGHT-CELLS.md`](../EIGHT-CELLS.md). The reference bridge in this repo has its own sheet filled in, holes included: [`examples/eight-cells-bridge.md`](../examples/eight-cells-bridge.md).

---

## The eight, in order

| # | Cell | The question | Where it lives |
|---|---|---|---|
| 1 | Reads | What it reads, and nothing else. | worksheet · code (`cwd`, `--tools`, the cage check) |
| 2 | Writes | What it can change or send. "Never writes" is a legal answer. | worksheet · code (`acceptEdits` inside the working directory only) · decides whether you need an [approval card](approval-card.md) |
| 3 | Identity | For every write that leaves the box: the stable id (never a filename), and what happens if it runs twice. | worksheet · code (`bridge/ledger.mjs`) · [identity.md](identity.md) |
| 4 | Limits | Timeouts, retries, maximum sends per run, per-sender rate. | worksheet · code (named constants) · [runs.md](runs.md) |
| 5 | Stop | The one line that stops it; what half-done work it leaves; whether it comes back after a reboot or re-login. | worksheet · code (SIGTERM, process group kill) · `scripts/pause.sh` · checklist (reboot test) · [launchd.md](launchd.md) |
| 6 | Proof | How you know it worked, other than exit 0 or the model saying so. | code (cage check, `permission_denials`, read-back) · checklist (probes with expected output) · [proof.md](proof.md) |
| 7 | Heartbeat | If it stops running, or the whole machine goes, who outside the machine notices, and within how long. | worksheet · code (`bridge/heartbeat.mjs`) · checklist · [heartbeat.md](heartbeat.md) |
| 8 | Rollback | Which backup to put back, which records to delete, and what "current version" means. | worksheet · `scripts/backup.sh` · [rollback.md](rollback.md) |

The order is fixed. Keep it, so two sheets can be compared line by line.

---

## 1. Reads

**Question:** what it reads, and nothing else.

For a bridge built as in the README, **the working directory is your answer to this cell**. The agent runs with `cwd` pinned to one folder, `--tools` limited to file tools, and `--strict-mcp-config` with no MCP servers. Reading outside that folder needs approval, which a headless run cannot get, so it is denied (§5). Any `--add-dir` you pass widens this cell; write it down or remove it.

Also list what the bridge process itself reads: its config, the session map, the ledger, the state file, and every inbound message. If you pull earlier group messages in as context, that is a read too, and anyone in the group wrote them, so they go into the prompt labelled as data, not instructions.

**A good answer:** "The notes folder `WORKDIR`, through Read, Glob and Grep; the bridge's own state folder; inbound DMs from my user id."
**A hole:** "Whatever it needs." That is not an answer; it is the absence of a cage.

## 2. Writes

**Question:** what it can change or send. "Never writes" is a legal answer.

List every place a write lands: files inside the working directory (the model, through `acceptEdits`), the bridge's own state files, chat messages and cards, and anything a privileged path touches. Then list what it must never write. Inside the working directory, `.claude/settings.local.json` matters most, because it can define hooks and hooks run shell commands in every later session; §5 shows that writing it is denied.

Answer from the tools you gave it, not from the task you gave it. A bot you only ask to reply can still edit every file its tools reach.

This cell, read together with Rollback, decides whether an action needs an [approval card](approval-card.md). Any one of the four tests true means a card: someone other than you can see the result; it touches real money or a ledger; it cannot be undone; the value written was generated by the model.

**A good answer:** "Files inside `WORKDIR` (model, auto-approved); replies and progress cards to my DM only; one action that writes outside `WORKDIR`, behind a card. Never: `.claude/` inside `WORKDIR`, any other chat."
**A hole:** "It only replies." Then check what its tools can do.

## 3. Identity

**Question:** for every write that leaves the box, the stable id (never a filename), and what happens if it runs twice. "Not applicable, never writes outside" is legal.

"Exactly once" is not available over a network. Platforms redeliver events, bridges restart mid-job, and people resend when no reply comes. What you can build is "at least once, plus a way to recognise a repeat". That needs an id that stays the same however many times the same thing is retried: the platform's own message id, an invoice number plus vendor, a fingerprint of the content.

**Never a filename.** Files get renamed, re-uploaded and copied. A worker that keys on the name sees the renamed file as new work and does it again, and nothing errors. And an id set kept only in memory is empty after every restart, which is exactly when a redelivery is most likely. Details in [identity.md](identity.md).

**A good answer:** "Inbound: the message's own id (not the delivery id), persisted in the ledger. A job found `running` after a restart is not rerun; I am told. Outbound: replies only, each sent with an idempotency key derived from the job, so a retried send is dropped by the platform instead of posted twice, where the platform honours the key."
**A hole:** "It won't run twice." Everything runs twice eventually.

## 4. Limits

**Question:** timeouts, retries, maximum sends per run, per-sender rate.

Every one of these should be a named constant in code, so the sheet can quote it and a reader can find it. For a bridge: the silence watchdog and its hard cap, a timeout on every send, a retry count with backoff, a cap on messages sent in one run, a per-message length cap, and what happens to messages that arrive while a job runs (acknowledge them at once).

Why each one: a fixed run timeout kills a long job at the deadline and leaves a hung one silent until it; a silence watchdog with a hard cap behind it tells the two apart. A send with no timeout of its own can hang after the run has finished, where the watchdog no longer looks, and hold the whole queue. An unbounded retry posts the same reply again and again. Details in [runs.md](runs.md).

**A good answer:** "Silence 5 min, hard cap 45 min, send timeout 60 s, 2 retries with backoff, at most 6 messages per run, one job at a time with an instant queued reply."
**A hole:** any limit that exists only as a number someone remembers.

## 5. Stop

**Question:** the one line that stops it; what half-done work it leaves; whether it comes back after a reboot or re-login.

Stopping a run (the Stop button, a timeout) is not stopping the worker. Unloading the worker is not stopping it for good either: `launchctl bootout` lasts only until the next login or reboot, because launchd loads every plist in `~/Library/LaunchAgents/` again at login. A worker stopped with `bootout` alone comes back on its own and keeps writing while your notes say "paused".

**Stopped for good means: `launchctl bootout`, then move the plist out of `~/Library/LaunchAgents/`, then pause any alarm that depends on the worker** (or it will alert every day). `scripts/pause.sh <label>` does the first two; `scripts/resume.sh <label>` reverses them. `launchctl disable` is not recommended for this: it survives a reboot, but the "stopped" state then lives in launchd's database, so `ls ~/Library/LaunchAgents` still shows the worker as installed. With the plist moved out, what you see is what is true.

Answer the half-done question too: if it is killed mid-job, what is left? A half-written file, a job marked `running` in the ledger, a sent message with no follow-up? Details in [launchd.md](launchd.md).

**A good answer:** "`scripts/pause.sh com.example.chat-bridge`; also pause the state-file watcher. A running job is killed as a group and marked `stopped`. Does not come back after reboot: the plist is not in LaunchAgents (checked with `ls` after one)."
**A hole:** "`bootout`." That answers the question up to the next login.

## 6. Proof

**Question:** how you know it worked, other than exit 0 or the model saying so.

Proof comes from something you can read back from outside: the runtime's own report of what it loaded, a record fetched by the id the target returned, a file whose content you checked. Never the model's account of itself.

Why: a model that refuses a forbidden action proves it followed its instructions, not that anything stopped it. If `permission_denials` is empty, it never reached for the tool, and the cage was not tested. Only the runtime's `system/init` event says which tools were actually loaded (§5). And exit 0 means the process ended, not that the write it was for happened. Details in [proof.md](proof.md).

**A good answer:** "Every run: init `tools` and `permissionMode` match the wanted set or the run is stopped. After every CLI upgrade: the lockdown probe with its expected output. Card actions: read back before marking done."
**A hole:** "exit 0", "it replied", "it said it was done".

## 7. Heartbeat

**Question:** if it stops running, or the whole machine goes, who outside the machine notices, and within how long.

Proof covers the run that happened. Heartbeat covers the run that never happened. A hung bridge produces no errors and no replies; from your phone it looks exactly like nobody has messaged it. A watcher on the same machine dies with the machine, so it is half an answer. **"Only on-machine; a dead machine is invisible" is a legal answer. A blank is not.**

Asking "who notices if the machine goes" also makes you trace what else depends on that machine: another device or service that depends on it, a job on another machine that reads its output, a person who expects its daily message. Write those down here too. Details in [heartbeat.md](heartbeat.md).

**A good answer:** "State file every 60 s; a same-machine watcher every 5 min alerts me on a different channel; an outside dead-man's switch expects a ping every 5 min and alerts after 15 min of silence."
**Also a good answer:** "State file and same-machine watcher only. Hole: a dead machine is invisible."

## 8. Rollback

**Question:** which backup to put back, which records to delete, and what "current version" means.

Before every change, take a dated backup with `scripts/backup.sh` and note its md5. Write the current version as "after backup X", so you know which copy undoes which change. List the records a change produced, so a rollback can remove them (by hand, with a human's yes). And list what cannot be rolled back at all: messages already sent, anything other people have already read. Those are candidates for an approval card.

One trap belongs here: **changing the source does not update copies already published from it.** For a bridge the published copies are the plist's environment block, cards already sitting in chats, a pinned message, a copy on another machine. Each keeps the old value, raises no error, and is often the one other people are looking at. Details in [rollback.md](rollback.md).

**A good answer:** "Current version = after `bridge.mjs.bak-watchdog-<date>` (md5 noted). Restore: copy back, `/restart`, rerun the proof. Sent messages: cannot be recalled."
**A hole:** "git has it." Only if the running copy is the one in git, and only for the code.

---

## Reading the sheet for an approval card

Read Writes and Rollback against the four tests in [approval-card.md](approval-card.md). If Rollback says "cannot be undone" for an action, or Writes names anyone other than you as a reader, that action goes through a card. If the sheet says a card is needed and the code has none, that is a hole; write it in.

## When to fill it again

- Every time you change the worker: the cells that changed get new answers, and the rest get a glance.
- After every Claude Code upgrade: rerun the Proof cell's probes; the cage is only as current as its last check.
- When a cell's answer turns out wrong in practice: fix the answer first, then the code, so the sheet stays the thing you trust.

---

## Checklist lines this chapter adds

- [ ] All eight cells filled **before** building; every unfilled cell reads `hole: <why>`, none blank.
- [ ] The sheet lives next to the code (or in the notes you actually read when you change the worker), not in a separate copy that will drift.
- [ ] Writes and Rollback read against the four approval-card tests; every action that passes a test has a card or a named hole.
- [ ] Sheet reviewed on every change to the worker and after every CLI upgrade.
