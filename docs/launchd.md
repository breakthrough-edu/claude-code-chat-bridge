# launchd: make it permanent, and make it stop

*Run the bridge as a macOS LaunchAgent so it starts on login and restarts on crash; get past the privacy system (TCC) and the cold boot; and know the difference between stopping a run, stopping the process, and stopping the worker for good. The last part is cell 5 of [the eight cells](eight-cells.md).*

Written against Claude Code 2.1.240 on macOS (September 2026). **Stop it for good is untested on your setup:** verify with [the stop test](../CHECKLIST.md#the-stop-test) (pause, log out and back in, then check `ls` and `launchctl print`). On Linux none of the TCC material applies; see [other-stacks-and-cost.md](other-stacks-and-cost.md).

---

## Install it as a user LaunchAgent

Run the bridge as a user **LaunchAgent** so it starts on login and restarts on crash. (It must be a *user agent*, not a system daemon, because it needs your keychain/login credentials.)

The template is [`bridge/com.example.chat-bridge.plist`](../bridge/com.example.chat-bridge.plist); the file is the truth, and its header comment repeats these steps. Copy it to `~/Library/LaunchAgents/com.example.chat-bridge.plist` and edit these lines:

- **Every `YOUR_USER`.** launchd does not expand `~` or `$HOME` inside a plist, so every path is absolute.
- **The `node` path**, if yours is not `/usr/local/bin/node`. Use a stable path, not a version-manager shim that changes on upgrade.
- **`BRIDGE_WORKDIR`**: the only directory the agent works in.
- **`CLAUDE_BIN`**: the line `which -a claude` prints that starts with `/`.
- **`BRIDGE_ALLOWED_USERS`** (required; the bridge will not start without it): your own sender id **under this bot app**, since `open_id` is per app. [lark-setup.md](lark-setup.md) shows how to find it.
- **`LARK_CLI`** (the absolute path `which lark-cli` prints; launchd's `PATH` is minimal) and **`LARK_PROFILE`** (the lark-cli profile of this bot app, from [lark-setup.md](lark-setup.md)).
- **Optional:** `BRIDGE_BOT_ID` (the bot's own id; without it, group messages are ignored), `BRIDGE_STATE_DIR` (the default is fine), and the commented-out `BRIDGE_OUTSIDE_DIR` and `BRIDGE_HEARTBEAT_URL` ([approval-card.md](approval-card.md), [heartbeat.md](heartbeat.md)).

The template keeps everything launchd itself opens under `~/Scripts/chat-bridge/`: the script, `WorkingDirectory`, and the log at `logs/bridge.log`. ⚠️ Keep it that way: **outside** `~/Documents`, `~/Desktop` and `~/Downloads` (see [the cold boot section](#a-plist-that-points-into-documents-works-until-the-first-cold-boot)). launchd does not create the logs folder for you.

Create the logs folder, check the file, and load it:

```bash
mkdir -p ~/Scripts/chat-bridge/logs
plutil -lint ~/Library/LaunchAgents/com.example.chat-bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.chat-bridge.plist
```

```bash
launchctl print gui/$(id -u)/com.example.chat-bridge | grep -E 'state|pid|last exit'
```

Test KeepAlive: kill the process and confirm a new pid appears. Reload after code edits with `launchctl kickstart -k gui/$(id -u)/com.example.chat-bridge`, **but see [the re-register section](#after-granting-full-disk-access-fully-re-bootstrap-the-job-kickstart-is-not-enough)**: that's not always enough. And never let the agent restart its own bridge from inside a run: that kills the process writing the reply, and you just see silence. Give yourself a `/restart` chat command that the bridge handles *before* calling Claude.

Test the bridge through launchd, not over SSH: an SSH session cannot reach the login keychain ([gotchas.md](gotchas.md) #2).

---

## Full Disk Access (TCC) is per-binary, per-machine, and does NOT migrate or sync

*(Gotcha #3.)*

Folders like `~/Documents`, `~/Desktop`, `~/Downloads`, and `~/Library/CloudStorage` (iCloud/Drive) are TCC-protected. **A launchd agent does not inherit the privacy grant your Terminal has.** So a job that works perfectly when you run it by hand will *silently* fail to read/write those folders under launchd. No crash, just "operation not permitted" or an empty result.

You must grant **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) to the **launch binary itself** (e.g. `/usr/local/bin/node`, `/bin/bash`, `/usr/bin/python3`), not to your script. And you must re-do it on every machine; grants don't travel with a migration or a synced dotfile.

This one root cause can masquerade as other failures: a `bash: Interrupted system call` (EINTR), a "hang" of several minutes, a native library failing to open its model or data file, or a file that was supposed to be written and silently never appears. **When a launchd job behaves bizarrely around protected folders, suspect TCC first** and stop chasing the surface symptom.

*The diagnostic that cracks it:* run the same file operation two ways: a throwaway launchd agent vs. an interactive shell. If interactive succeeds and launchd gets "operation not permitted", that delta **is** the TCC signature.

## Child processes and Full Disk Access

*(Gotcha #16. Untested on your setup: verify with `sample <pid>` on a stuck child, as below.)*

The grant belongs to the binary launchd starts. Whether the processes *that* binary starts are covered depends on what the binary is. `/usr/bin/python3` on macOS is a small stub that hands off to a Python app inside the developer tools, and a Full Disk Access grant it holds does not reach its children: a child that opens a protected path (`claude -p`, `ffmpeg`, a transcription tool) sits at zero output and zero CPU until its timeout, with no error at all. With `/usr/local/bin/node` as the launchd program and the grant on node, the children it starts are covered.

- If your launchd job touches protected folders **and** starts child processes, make the launchd program `node` (a ten-line launcher that starts the real script is enough), not python directly. The reference bridge is node already.
- When the symptom is "zero output, zero CPU, gets longer the longer you wait" rather than an error, take a stack sample of the stuck child (`sample <pid>` on macOS). If it is sitting in an `open` call, it is TCC waiting on a permission prompt nobody can see. Do not start changing code to guess.
- A child that seems to "fix itself" some day has usually had its hidden prompt clicked by someone at the screen.

## After granting Full Disk Access, fully re-bootstrap the job: `kickstart` is not enough

*(Gotcha #5.)*

A job that was loaded *before* the grant may keep its stale, pre-grant registration even after `kickstart -k`. Do a full re-register: `launchctl bootout gui/$(id -u)/com.example.chat-bridge`, then `bootstrap` it again as in [the install section](#install-it-as-a-user-launchagent).

## A plist that points into `~/Documents` works until the first cold boot

*(Gotcha #7.)*

If the script, `WorkingDirectory` or a log path sits in a TCC-protected folder, installing and restarting while you are logged in works every time. After a cold reboot the job refuses to start: `launchctl print` shows `last exit code = 78: EX_CONFIG`, and stderr is empty. Keep everything launchd itself opens under something like `~/Scripts/`, and after any change, reboot once (or scan every plist) to prove it.

The three things launchd itself opens are the `WorkingDirectory`, the two log paths, and the program in `ProgramArguments`. Files in protected folders can still be read by the child processes your launcher starts, because they run under the launch binary's grant (with the python caveat above).

---

## Three kinds of stop

These are different operations, and mixing them up is how a worker you "stopped" keeps running.

| You want to stop | How | Does it come back? |
|---|---|---|
| One run | the Stop button, the silence watchdog or the hard cap, all of which kill the process group ([runs.md](runs.md)) | the next message starts a new run |
| The bridge process | `kickstart -k`, a crash, or killing the pid | **yes, at once**: that is what `KeepAlive` is for |
| The worker, for good | the three steps below | no, not after a reboot and not after a re-login, if the steps were done |

## Stop it for good

**Stopped for good means three things, done together:**

1. **Unload it:** `launchctl bootout gui/$(id -u)/<label>`. This sends the bridge SIGTERM, and the bridge stops its running job before it exits ([runs.md](runs.md)).
2. **Move the plist out of `~/Library/LaunchAgents/`**, into a folder launchd never loads from. Anywhere outside `LaunchAgents` works.
3. **Pause every alarm that depends on it.** The state-file watcher on the same machine and any outside heartbeat check ([heartbeat.md](heartbeat.md)) will otherwise report the worker dead every day, and an alarm you learn to ignore is no alarm.

`scripts/pause.sh <label>` does steps 1 and 2 for one label: it boots the job out if it is loaded and moves its plist into `~/Library/LaunchAgents-paused/` (set `PAUSED_DIR` to choose another folder). It deletes nothing and touches no other file. `scripts/resume.sh <label>` reverses it. Read the header of each script before you run it. Step 3 is yours: the alarm usually lives somewhere a local script cannot reach.

**Why `bootout` alone is not a stop.** `bootout` lasts until the next login or reboot. At login, launchd loads every plist it finds in `~/Library/LaunchAgents/` again, so a worker stopped with `bootout` alone comes back on its own, and it comes back doing exactly what it did before, including writing to live data, while your notes still say "paused". A reboot is not the only trigger: logging out and in, or switching user accounts, does the same.

**Why not `launchctl disable`.** It does survive a reboot. But the "stopped" state then lives inside launchd's own database: `ls ~/Library/LaunchAgents` still shows the plist as if the worker were installed and running, and only `launchctl print-disabled gui/$(id -u)` tells the truth. The failure being fixed here is "the state does not match what you can see"; a second, invisible state makes that worse. Resuming also needs an extra `enable` step, and a missed step is an error. Doing both (`disable` and moving the plist) adds a step to forget for something you switch a few times a year.

**Prove it.** After pausing:

- `ls ~/Library/LaunchAgents/ | grep <label>` prints nothing;
- `launchctl print gui/$(id -u)/<label>` reports that it cannot find the service;
- the worker's log stops growing;
- then log out and back in (or reboot), and check all three again. This last step is the one that catches `bootout` alone. The full sequence is [the stop test](../CHECKLIST.md#the-stop-test) in the checklist.

**Write it down.** In your notes, next to the worker's eight cells, write where the plist went and the three reverse steps. The Stop cell in [EIGHT-CELLS.md](../EIGHT-CELLS.md) should also answer what half-done work a stop can leave; for a job killed mid-run, see [identity.md](identity.md).

## Resume it

The reverse, in order:

1. Move the plist back into `~/Library/LaunchAgents/`.
2. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`, then check `state` and `pid` with `launchctl print` as in the install section.
3. Turn the alarms back on, and send the bot one real message to prove it answers.

`scripts/resume.sh <label>` does steps 1 and 2: it lints the plist, moves it back, and bootstraps it. It refuses if a plist with that label is already in `~/Library/LaunchAgents/`, so it cannot overwrite a newer copy.

---

## Checklist lines this chapter adds

- [ ] The bridge runs as a user LaunchAgent from the shipped template, with every `YOUR_USER` and `ou_xxx` replaced, `BRIDGE_ALLOWED_USERS`, `LARK_CLI` and `LARK_PROFILE` set, and `plutil -lint` clean.
- [ ] Nothing launchd opens lives under `~/Documents`, `~/Desktop` or `~/Downloads`; survived one cold reboot.
- [ ] Full Disk Access granted to the launch binary on this machine (if the job touches protected folders), followed by `bootout` and `bootstrap`, not `kickstart`.
- [ ] If the job starts child processes that touch protected folders, the launchd program is `node`, not python.
- [ ] `/restart` is a chat command the bridge handles before calling Claude; the agent never restarts its own bridge.
- [ ] [The stop test](../CHECKLIST.md#the-stop-test) passed: `pause.sh` run on the label, plist absent from `~/Library/LaunchAgents`, still absent and not running after a re-login or reboot, dependent alarms paused; `resume.sh` brought it back.
- [ ] Where the paused plist lives, and the three reverse steps, are written next to the worker's eight cells.
