# Changelog

What changed in this guide, newest first. If you built from an older version, the "If you built from" line under each entry says what to redo.

---

## v2, 2026-09-25

Each chapter says which versions it was written against and marks what to verify on your setup.

**Shape.** The single README is split into a front door and chapters, because a guide you can read in ten minutes and a tool you can run are two different things:

- `README.md` keeps what the guide is, why it is built this way, the two integration points and the hardened `claude -p` run (§5), and links to everything else.
- `docs/` holds one chapter per topic. Moved from the README, with every fact kept: [runs.md](docs/runs.md) (progress, Stop, slow vs stuck), [sessions-and-groups.md](docs/sessions-and-groups.md), [launchd.md](docs/launchd.md), [privileged-path.md](docs/privileged-path.md), [gotchas.md](docs/gotchas.md), [build-or-adopt.md](docs/build-or-adopt.md), [other-stacks-and-cost.md](docs/other-stacks-and-cost.md). New: [lark-setup.md](docs/lark-setup.md), setting up the Lark bot app end to end, finding your own id with `scripts/whoami.sh`, and testing without a phone.
- `bridge/` is a reference implementation of the code the README used to show in pieces, with an offline test suite (`npm test`, which runs `node --test bridge/test/*.test.mjs`) that runs the whole loop against a fake `claude` and a fake chat platform.
- `scripts/` holds small tools: a clean-env login probe, pause and resume for a launchd worker, a dated backup, and a transcript replay for tuning the silence watchdog.
- `EIGHT-CELLS.md` is a worksheet, `CHECKLIST.md` the full checklist, and this file replaces the README's "What changed" paragraph.

**New: the eight cells.** Every worker that runs while you are not watching answers eight questions before it is built: Reads, Writes, Identity, Limits, Stop, Proof, Heartbeat, Rollback. A cell you cannot fill is written as a hole, never left blank. See [docs/eight-cells.md](docs/eight-cells.md), with one chapter each for [proof](docs/proof.md), [identity](docs/identity.md), [heartbeat](docs/heartbeat.md) and [rollback](docs/rollback.md).

**New: the approval card.** Four tests decide which actions need a person's tap; the card pins the exact content, and on the tap the program executes that pinned content, not a fresh answer from the model. See [docs/approval-card.md](docs/approval-card.md). The privileged path is reworded as the same idea ([docs/privileged-path.md](docs/privileged-path.md)).

**New in the ops chapters:**

- Limits as named constants: send timeout, retry count, maximum sends per run, per-sender rate, message length cap ([runs.md](docs/runs.md#limits-put-a-number-on-everything-that-can-run-away)).
- Stopping a worker for good: unload it, move its plist out of `~/Library/LaunchAgents`, and pause the alarms that depend on it; why `bootout` alone and `launchctl disable` are not enough; how to prove it and how to resume ([launchd.md](docs/launchd.md#stop-it-for-good)).
- Child processes of a launchd program may not inherit its Full Disk Access (python as the parent) ([launchd.md](docs/launchd.md#child-processes-and-full-disk-access)).
- Gotchas 11 to 24: a hook that never returns under launchd; false and real "OAuth session expired" and the one probe that tells them apart; launchd adding `USER` and `SHELL`; `import()` of the bot file starting a second consumer; a scheduled job's first start; parsers fed one real model output; dates resolved in code; image links in Lark markdown replies, now neutralised on every send path by `neutraliseImageLinks` in `bridge/platform-lark.mjs`; deduping on `message_id`; the traps in replaying transcripts; `node --test` on Node 24; error 20069 from a disabled Lark app ([gotchas.md](docs/gotchas.md)).
- The launchd chapter now points to the shipped plist template, `bridge/com.example.chat-bridge.plist`, instead of an inline plist, and lists the lines to edit ([launchd.md](docs/launchd.md#install-it-as-a-user-launchagent)).
- The traps to check in any mid-turn approval relay, and why this guide pins content on a card instead ([build-or-adopt.md](docs/build-or-adopt.md)).
- Where the tokens go in a headless run: the fixed overhead is the bulk, so savings come from fewer runs ([other-stacks-and-cost.md](docs/other-stacks-and-cost.md)).

**Changed:** "keep a set of recently seen event ids" becomes "persist the ids you have handled", keyed on the message id (Lark: `message_id`, not `event_id`; see [identity.md](docs/identity.md) and gotcha #21); an in-memory set forgets everything on restart.

**If you built from the September 2026 version:** fill the eight cells for your bridge, persist your handled message ids (keyed on `message_id`), add a send timeout, and run the stop test in [launchd.md](docs/launchd.md#stop-it-for-good) on your worker.

---

## September 2026 update, 2026-09-24

**Three corrections to §5, the hardened run:**

- The child's scrubbed environment was missing `USER` and `SHELL`. Without them `claude -p` cannot find the login in the keychain and reports "OAuth session expired" while the login is fine (gotcha #1).
- The tool gate did not restrict anything. `--allowedTools` only pre-approves tools; it does not unload the rest. Replaced with `--tools`, the real allowlist (gotcha #10).
- The lockdown proof asked the model. It now checks the runtime: the `system/init` event's `tools` and `permissionMode` on every run, stopping the run as a CAGE BREACH on a mismatch, plus a proof checked outside the chat.

**Also changed in §5:** output switched from `json` to `stream-json` with `--verbose` and `--include-partial-messages`; `claude` spawned by absolute path (`CLAUDE_BIN`), since a scrubbed `PATH` may not find it; the child spawned `detached` so a stop can kill its whole process group; `permission_denials` logged from the result event. Written against Claude Code 2.1.240.

**New sections:** live progress on a card updated in place, and a Stop button (§7); telling "slow" from "stuck" with a silence watchdog and a hard cap, acknowledging queued messages, and a state file watched from outside the bridge (§8); groups (§9); build or adopt (§13).

**Session continuity:** store a session id only from a successful run, and retry once without `--resume` when a stored session is dead.

**Gotchas:** now ten. New: testing over SSH (#2), the permission flag against merged `--settings` files (#4), a plist pointing into `~/Documents` failing at the first cold boot (#7), `claude -p` declining to fake a long wait (#9), and `--allowedTools` (#10). The June gotcha "keep the inbound stream's stdin open" now lives only in §4.

**If you built from the June version:** read §5 again and replace your tool gate.

---

## First version, 2026-06-18

A self-contained guide to driving a headless Claude Code agent from a chat app (Lark/Feishu as the example) on an always-on Mac: the two integration points, a hardened `claude -p` invocation, session continuity, launchd persistence, the scoped privileged path, six launchd and TCC gotchas, a security checklist, notes on other stacks and on billing.
