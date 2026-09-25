# Checklist

*Every checklist line from every chapter, deduplicated and grouped by when you tick it. Each line links the chapter that explains it. The ten most load-bearing lines are also in the [README](README.md#10-the-short-checklist).*

Written against Claude Code 2.1.240 (September 2026). On another version, run `scripts/probe-claude.sh` first.

A line you cannot tick is not a failure of the checklist. Write it into your [EIGHT-CELLS.md](EIGHT-CELLS.md) as `hole: <why>`, and decide whether you accept it for now.

---

## Before you build

- [ ] All eight cells filled **before** building; every cell you cannot fill reads `hole: <why>`, none blank. ([eight-cells.md](docs/eight-cells.md))
- [ ] Every hole listed at the bottom of the sheet with what would close it, marked accepted or to fix. ([EIGHT-CELLS.md](EIGHT-CELLS.md#holes))
- [ ] The sheet lives next to the code (or in the notes you actually read when you change the worker), not in a separate copy that will drift. ([eight-cells.md](docs/eight-cells.md))
- [ ] Every write that leaves the box has a named stable id (never a filename) in the Identity cell, and your choice for a leftover `received` job is written there. ([identity.md](docs/identity.md))
- [ ] The privileged path, if any, is listed by name in the Writes cell. ([privileged-path.md](docs/privileged-path.md))
- [ ] Every limit is a named constant, with its value written in the Limits cell. ([runs.md](docs/runs.md#limits-put-a-number-on-everything-that-can-run-away))
- [ ] Rollback cell lists what cannot be undone (sent messages at least); each of those actions reviewed for an approval card. ([rollback.md](docs/rollback.md))
- [ ] Heartbeat cell names who outside the machine notices and within how long, **or** reads "only on-machine; a dead machine is invisible". Never blank. ([heartbeat.md](docs/heartbeat.md))
- [ ] If adopting a maintained bridge instead: its permission defaults and allowlists read and locked down before it is connected to anything, its license confirmed, and its eight cells filled. ([build-or-adopt.md](docs/build-or-adopt.md))

---

## Build

### The cage

- [ ] `--permission-mode acceptEdits` (or stricter) on the command line; never `bypassPermissions`. ([README §5](README.md#5-the-core-running-headless-claude-safely))
- [ ] `--tools` with exactly the tools you want (`--allowedTools` is not a restriction). ([README §5](README.md#5-the-core-running-headless-claude-safely), [gotcha #10](docs/gotchas.md))
- [ ] `--strict-mcp-config` with no `--mcp-config`: no MCP servers exposed. ([README §5](README.md#5-the-core-running-headless-claude-safely))
- [ ] Working directory pinned; no `--add-dir` you did not intend. ([README §5](README.md#5-the-core-running-headless-claude-safely))
- [ ] Scrubbed env that still includes `USER` and `SHELL`, checked on the live process with `ps eww`, not in the plist; message passed via argv, never a shell string; `claude` spawned by absolute path. ([gotchas #1 and #14](docs/gotchas.md), [README §5](README.md#5-the-core-running-headless-claude-safely))
- [ ] Every run checks the `system/init` event: `tools` and `permissionMode` match exactly (logged as `cage ok: tools=... mode=...`), or the run stops as a **CAGE BREACH** and the chat is told; a result with no init event is a breach too. ([proof.md](docs/proof.md))
- [ ] Every denial logged as `denied: <tool> <input>`; zero-tool calls assert `num_turns` 1 and no denials. ([proof.md](docs/proof.md))
- [ ] Global `~/.claude/settings.json` read line by line: no hook that can wait forever under launchd. ([gotcha #11](docs/gotchas.md))

### Who can drive it

- [ ] Bot answers only **your own user id**; in groups, only when **@-mentioned**, enforced in code. ([sessions-and-groups.md](docs/sessions-and-groups.md#groups))
- [ ] If you add group context (not in the reference bridge): labelled in the prompt as data, not instructions. ([sessions-and-groups.md](docs/sessions-and-groups.md#groups))
- [ ] Every allowlisted id re-resolved under each new bot app (`open_id` is per app). ([sessions-and-groups.md](docs/sessions-and-groups.md#groups))
- [ ] Stop and card taps gated by the same allowlist as senders. ([runs.md](docs/runs.md#the-stop-button))

### The Lark app

- [ ] lark-cli (`@larksuite/cli`) installed; its absolute path is in `LARK_CLI`; the plist's `PATH` includes the folder `node` lives in. ([lark-setup.md](docs/lark-setup.md#1-install-lark-cli))
- [ ] The bot app created with `--name <profile>` (default profile untouched), on the machine that runs the bridge; the profile name is in `LARK_PROFILE`; the bot found in chat by its console display name. ([lark-setup.md](docs/lark-setup.md#2-create-the-bot-app-as-a-named-profile))
- [ ] `card.action.trigger` added through the launcher link in the card listener's error; `[event] ready` seen for it afterwards. ([lark-setup.md](docs/lark-setup.md#3-what-the-new-app-does-out-of-the-box-and-the-one-thing-it-lacks))
- [ ] Only one consumer per event key of this app, on any machine. ([lark-setup.md](docs/lark-setup.md#4-events-are-not-replayed-start-listening-before-you-send))
- [ ] Every test starts the listener first and sends second. ([lark-setup.md](docs/lark-setup.md#4-events-are-not-replayed-start-listening-before-you-send))
- [ ] Your `open_id` under **this** app found with `scripts/whoami.sh <profile>` (bridge stopped first) and set in `BRIDGE_ALLOWED_USERS`; the bot's own id in `BRIDGE_BOT_ID` only if it should answer in groups. ([lark-setup.md](docs/lark-setup.md#5-find-your-own-id-and-the-bots))
- [ ] Every card test has a person to tap the button. ([lark-setup.md](docs/lark-setup.md#7-testing-without-a-phone))

### Messages and sessions

- [ ] Handled message ids persisted to disk (atomic write, bounded list), keyed on the message's own id (Lark: `message_id`, not `event_id`); marked handled before acting. ([identity.md](docs/identity.md), [gotcha #21](docs/gotchas.md))
- [ ] Session ids stored only from successful runs; a dead `--resume` retries fresh once. ([sessions-and-groups.md](docs/sessions-and-groups.md))
- [ ] `/new` resets the thread; the session map is persisted to disk. ([sessions-and-groups.md](docs/sessions-and-groups.md))
- [ ] Image links neutralised in model replies on every markdown send path (messages and cards). ([gotcha #20](docs/gotchas.md))
- [ ] Every parser of model output tested on one saved real model output; raw output saved on a parse failure. ([gotcha #18](docs/gotchas.md))
- [ ] Dates resolved in code before they reach the model. ([gotcha #19](docs/gotchas.md))

### Runs and limits

- [ ] Progress card shows one line per tool call and updates in place; the finished card is re-rendered whole with no Stop button. ([runs.md](docs/runs.md#show-progress-and-let-yourself-stop-it))
- [ ] Stop taps handled in the callback, not the queue. ([runs.md](docs/runs.md#the-stop-button))
- [ ] Child spawned `detached`; Stop and timeouts kill the **process group** and force the pipes shut; leftovers from a crash are killed on startup. ([runs.md](docs/runs.md#stopping-must-kill-the-whole-tree))
- [ ] Silence watchdog plus a hard cap; the chat is told plainly when a run was stopped. ([runs.md](docs/runs.md#tell-slow-from-stuck))
- [ ] Queued messages acknowledged at once. ([runs.md](docs/runs.md#tell-slow-from-stuck))
- [ ] Limits in code: send timeout, retries and backoff, sends per run, per-sender rate, inbound and reply length, queue size. ([runs.md](docs/runs.md#limits-put-a-number-on-everything-that-can-run-away))
- [ ] Every send carries a stable key reused across its retries. ([runs.md](docs/runs.md#limits-put-a-number-on-everything-that-can-run-away))
- [ ] A refused message is told which limit it hit; every other limit that fires leaves a log line. ([runs.md](docs/runs.md#limits-put-a-number-on-everything-that-can-run-away))
- [ ] Any timed task decides on startup whether today already ran, and defaults to not catching up. ([gotcha #17](docs/gotchas.md))

### Identity and proof

- [ ] Job ledger with at least `received` / `running` / `replying` / `done` / `failed` / `stopped`, each written before the step it names. ([identity.md](docs/identity.md#the-job-ledger))
- [ ] After a restart, a `running` or `replying` job is **not** rerun; the user gets one line saying it was interrupted. ([identity.md](docs/identity.md#the-job-ledger))
- [ ] Outbound writes: check before write, read back after; same id with different content stops and alerts, never overwrites. ([identity.md](docs/identity.md))
- [ ] No automatic deletion of suspected duplicates. ([identity.md](docs/identity.md))
- [ ] No write marked done on exit 0; done means read back. ([proof.md](docs/proof.md#proof-of-a-write-is-a-read-back))
- [ ] Every failed check lands where a human looks, not only in a log. ([proof.md](docs/proof.md#where-proof-lands))

### Heartbeat

- [ ] State file written atomically every 60 s, carrying the current job's deadline, the overall `connection` and each listener's state. ([heartbeat.md](docs/heartbeat.md#layer-1-the-state-file))
- [ ] A same-machine watcher alerts once per incident and once on recovery, through a path that does not depend on the bridge. ([heartbeat.md](docs/heartbeat.md#layer-2-a-watcher-on-the-same-machine))
- [ ] The watcher alarms only on states that mean trouble; a missing state file is no judgement. ([heartbeat.md](docs/heartbeat.md#layer-2-a-watcher-on-the-same-machine))
- [ ] If an outside ping is on, it stops when the bridge is deaf (and, without a same-machine watcher, when a job is stuck). ([heartbeat.md](docs/heartbeat.md#layer-3-outside-the-machine))

### The privileged path

- [ ] One *audited, fixed-script* privileged path at most, reachable only from typed text. ([privileged-path.md](docs/privileged-path.md))
- [ ] The model never fills in a command, path or recipient for it; it chooses from a closed set and drafts values at most. ([privileged-path.md](docs/privileged-path.md))
- [ ] Every privileged action read against the four approval-card tests; any action that passes one goes through a card. ([privileged-path.md](docs/privileged-path.md))

### Code hygiene and cost

- [ ] Load checks use `node --check`, never `import()` of the bot file. ([gotcha #15](docs/gotchas.md))
- [ ] Tests run as `node --test bridge/test/*.test.mjs` (a glob), not a directory. ([gotcha #23](docs/gotchas.md))
- [ ] Shell scripts under launchd run as in-memory `bash -c`. ([gotcha #6](docs/gotchas.md))
- [ ] Dashboards and notifications show tokens and seconds, never `total_cost_usd`. ([other-stacks-and-cost.md](docs/other-stacks-and-cost.md))
- [ ] One run's usage split into its four parts before any cost-saving work; savings sought in fewer runs first. ([other-stacks-and-cost.md](docs/other-stacks-and-cost.md#where-the-tokens-go-the-fixed-overhead-is-the-bulk))

### If you port it

- [ ] On another chat app: the five platform functions in `bridge/platform.mjs` reimplemented; nothing else changed. ([other-stacks-and-cost.md](docs/other-stacks-and-cost.md))
- [ ] On Linux: `WorkingDirectory`, a clean `Environment=` with `USER` and `SHELL`, `Restart=always`, credentials reachable by the service user. ([other-stacks-and-cost.md](docs/other-stacks-and-cost.md))
- [ ] Any mid-turn approval relay has a timeout that counts as deny, buttons carrying the request id and a nonce, button-only approval, "approve all" scoped to one run, and cards repainted spent after a tap; proved to fire with one deliberate real request, with `permissionMode` read from the init event. ([build-or-adopt.md](docs/build-or-adopt.md#mid-turn-approval-a-relay-or-a-card))

---

## Launch day

- [ ] Offline suite green: `npm test`. ([README §6](README.md#6-quick-start))
- [ ] The bridge ran in the foreground with `node --env-file=bridge/.env bridge/bridge.mjs` before the LaunchAgent was installed. ([lark-setup.md](docs/lark-setup.md#6-run-it-in-the-foreground-first))
- [ ] One test message confirmed by a `job <id> done in <N>s; reply sent` line in the log; a `reply NOT confirmed sent` line checked in the chat before any resend. ([lark-setup.md](docs/lark-setup.md#7-testing-without-a-phone))
- [ ] Login and cage probed with `scripts/probe-claude.sh` from your own terminal (never over SSH, never from a sandboxed agent shell): it prints `cage: MATCH` and exits 0. ([proof.md](docs/proof.md), [gotchas #12 and #13](docs/gotchas.md))
- [ ] Lockdown checked in the log, never from the reply: `cage ok:` shows no `Bash` in `tools=`; a request to read `/etc/hosts` logs `denied: Read /etc/hosts` (a refusal with no `denied:` line is not a pass, ask again); a request to write `.claude/settings.local.json` logs `denied: Write`; `test.txt` written inside the working directory. ([proof.md](docs/proof.md#the-probes-with-what-you-should-see))
- [ ] The bridge runs as a user LaunchAgent from the shipped template, with every `YOUR_USER` and `ou_xxx` replaced, `BRIDGE_ALLOWED_USERS`, `LARK_CLI` and `LARK_PROFILE` set, and `plutil -lint` clean; started by a stable absolute `node` path with `RunAtLoad` and `KeepAlive`; KeepAlive tested by killing the process and seeing a new pid. ([launchd.md](docs/launchd.md#install-it-as-a-user-launchagent))
- [ ] Nothing launchd opens lives under `~/Documents`, `~/Desktop` or `~/Downloads`; survived one cold reboot. ([launchd.md](docs/launchd.md#a-plist-that-points-into-documents-works-until-the-first-cold-boot))
- [ ] Full Disk Access granted to the launch binary on this machine (if the job touches protected folders), followed by `bootout` and `bootstrap`, not `kickstart`. ([launchd.md](docs/launchd.md#after-granting-full-disk-access-fully-re-bootstrap-the-job-kickstart-is-not-enough))
- [ ] If the job starts child processes that touch protected folders, the launchd program is `node`, not python. ([launchd.md](docs/launchd.md#child-processes-and-full-disk-access))
- [ ] `/restart` is a chat command the bridge handles before calling Claude; the agent never restarts its own bridge. ([launchd.md](docs/launchd.md#install-it-as-a-user-launchagent))
- [ ] Restart test: a slow request, the bridge killed with `kill -9` mid-run, launchd restarts it; you get the "interrupted" line, **no** `claude` process is left over (startup killed the orphan), and the log shows `claude` started only once for that job. ([identity.md](docs/identity.md#the-job-ledger))
- [ ] Watchdog numbers checked against a replay of your own transcripts (`scripts/replay-transcripts.mjs`), read as upper bounds with repeated `uuid`s skipped. ([runs.md](docs/runs.md#tell-slow-from-stuck), [gotcha #22](docs/gotchas.md))
- [ ] You know what a `FATAL` with 20069 in the log means: check the app in the Lark console before any code is changed. ([lark-setup.md](docs/lark-setup.md#8-when-the-app-is-disabled-error-20069), [gotcha #24](docs/gotchas.md))
- [ ] Heartbeat test: bridge stopped longer than the frozen threshold gives exactly one "down" alert, restarting gives exactly one "recovered", a long normal job gives none. ([heartbeat.md](docs/heartbeat.md#layer-2-a-watcher-on-the-same-machine))
- [ ] A dated `.bak-<label>-<date>` backup with its md5 noted before every change (`scripts/backup.sh`), state files included when their format changes. ([rollback.md](docs/rollback.md))
- [ ] "Current version = after backup X" written down and checked against the running file's md5. ([rollback.md](docs/rollback.md#current-version-means-after-which-backup))
- [ ] Restore procedure tried once: copy back, md5 match, restart, proof rerun. ([rollback.md](docs/rollback.md#restoring))
- [ ] After changing any source value, every published copy (plist env, live cards, pinned text, other machines) listed and fixed. ([rollback.md](docs/rollback.md#published-copies-do-not-resync))

---

## After every Claude Code or lark-cli upgrade

- [ ] `scripts/probe-claude.sh` still prints `cage: MATCH`; if not, do not restart the bridge until it does. ([proof.md](docs/proof.md))
- [ ] `claude --help` still lists `--tools`; if it does not, see the fallback in [README §5](README.md#5-the-core-running-headless-claude-safely).
- [ ] Lockdown rerun from real bot messages and checked in the log: `cage ok:` with no `Bash`, `denied: Read /etc/hosts`. ([proof.md](docs/proof.md#the-probes-with-what-you-should-see))
- [ ] If you run a mid-turn relay: `claude --help` rechecked for the flag it depends on. ([build-or-adopt.md](docs/build-or-adopt.md#mid-turn-approval-a-relay-or-a-card))
- [ ] After a lark-cli upgrade: `lark-cli --version` noted; both listeners still print `[event] ready` in the bridge log; one real DM round trip ending in `job <id> done in <N>s; reply sent`, and one Stop tap; the flags the bridge passes (`--as`, `--profile`, `--idempotency-key`, `--markdown`) checked against the new version's help. ([bridge/platform-lark.mjs](bridge/platform-lark.mjs), [gotcha #20](docs/gotchas.md))
- [ ] If node itself was upgraded or moved: the plist's node path still exists, and the Full Disk Access grant is on that binary. ([launchd.md](docs/launchd.md#full-disk-access-tcc-is-per-binary-per-machine-and-does-not-migrate-or-sync))
- [ ] Eight cells sheet reviewed: the Proof cell's probes rerun, changed cells answered again. This also applies on every change to the worker. ([eight-cells.md](docs/eight-cells.md#when-to-fill-it-again))

---

## The stop test

Run it once on a throwaway label first, then on the bridge. Unverified on your setup until the re-login step has passed. ([launchd.md](docs/launchd.md#stop-it-for-good))

- [ ] `scripts/pause.sh <label>` run; it prints `paused:` and where the plist went.
- [ ] `ls ~/Library/LaunchAgents/ | grep -F <label>` prints nothing.
- [ ] `launchctl print gui/$(id -u)/<label>` reports that it cannot find the service.
- [ ] The worker's log stops growing.
- [ ] Every alarm that depends on the worker paused (same-machine watcher, outside heartbeat).
- [ ] Logged out and back in (or rebooted), and the three checks above still hold.
- [ ] `scripts/resume.sh <label>` brought it back; `launchctl print` shows it running; alarms turned back on; one real message answered.
- [ ] Where the paused plist lives, and the reverse steps, written next to the worker's eight cells.

---

## Approval card

([approval-card.md](docs/approval-card.md))

- [ ] Every action in Writes and Rollback read against the four tests; each one that passes a test has a card or a named hole.
- [ ] The model has no tool that can perform a carded action; it can only leave a draft in `outbox/`.
- [ ] The card shows the full target and the full content, "not yet written", and buttons carrying the draft id and fingerprint.
- [ ] On a tap the program executes the pinned draft; the model is not asked again.
- [ ] Single-use claim written to disk before the action runs; a double tap runs the action once (offline test green).
- [ ] Every failure returns the draft to pending with its buttons; success only after a read-back; the card repainted spent with no buttons.
- [ ] Carded writes use the draft id as their stable id: check before, read back after, same id with different content is an error.
- [ ] One real card tapped by a person on your own test app (approve once, reject once) before trusting it. ([approval-card.md](docs/approval-card.md#verifying-it))
- [ ] Reverse check done monthly: if every card in thirty days was approved unchanged, the criteria are too wide. ([approval-card.md](docs/approval-card.md#the-reverse-check))
