# Heartbeat: who notices when it is not running

*Cell 7 of [the eight cells](eight-cells.md). If it stops running, or the whole machine goes, who outside the machine notices, and within how long.*

Written 2026-09-25 against Claude Code 2.1.240. On another version, run the probes in [proof.md](proof.md) first. The reference code is `bridge/heartbeat.mjs`; the file is the truth. The outside ping is off by default, and until you point it at a service and watch an alert arrive (the test below), it is unverified on your setup.

---

## Why this is not the same as Proof

[Proof](proof.md) tells you a run that happened went right. It says nothing about the run that never happened. A bridge that has hung, lost its connection, or died with its machine produces no errors, no bad replies, nothing at all. From your phone it looks exactly like nobody has messaged it. The bridge cannot report its own death.

So the question has three layers, and each covers a failure the one before it cannot see.

| Layer | What it is | Catches | Blind to |
|---|---|---|---|
| 1. State file | the bridge writes its own status every 60 s | nothing by itself; it is what the other layers read | everything, unless someone reads it |
| 2. Same-machine watcher | a separate launchd job reads the state file every few minutes and alerts you | the bridge frozen, a job stuck past its deadline, the chat connection down | the machine itself: power, network, a kernel panic, a machine stuck at a login screen |
| 3. Outside the machine | something on another computer expects to hear from the bridge and alerts when it stops | all of the above, plus the whole machine gone | only whether you read the alert |

---

## Layer 1: the state file

`bridge/heartbeat.mjs` writes a small JSON file every 60 seconds. It writes atomically (temp file, then rename), so a reader never sees half a file. What the reference puts in it:

- `ts`: when this was written
- `pid`: the bridge's own pid
- `job`: the current job's id and **deadline** (null when idle)
- `connection`: one word for the whole bridge: `listening` only when every listener is up, `down` as soon as any listener is down or closed (or after a fatal listener error), `starting` in between, `closed` after a clean shutdown
- `listeners`: each listener's own state (the reference has two: messages and card taps; losing the second one means the Stop button no longer works, which is partly deaf)
- `lastPingOk`: whether the last outside ping (layer 3) got an answer, if you turned it on

Add anything your watcher needs, such as when the last reply was sent. Keep it small.

The deadline is the key field. It lets a reader tell "busy" from "stuck" without knowing anything about the job.

## Layer 2: a watcher on the same machine

A separate launchd job, run every five minutes or so, reads the state file and decides three things. The reference bridge does not ship this watcher: it is a short script you write against the state file, with its own plist and its own eight cells.

What it decides:

- **frozen:** `ts` older than about five minutes. The process is gone or its event loop is stuck.
- **stuck:** a job past its deadline plus a grace period.
- **down:** `connection` has reported a state that **positively means trouble** (`down` in the reference) for more than about ten minutes. Read `listeners` to say which one.

**Trust `connection` first.** After a clean shutdown it reads `closed`, and `listeners` may still show the last states it wrote (`listening`), because the final beat can be written before the listeners have closed. Read `listeners` only to explain a `down`, never to decide whether the bridge is up.

Rules for the watcher, and why:

- **Alert once per incident and once on recovery.** Not every five minutes. An alarm that repeats gets muted.
- **Alert through a different path than the bridge.** A bridge that is down cannot deliver its own alarm. Use another bot, email, a push service.
- **Alarm only on states that mean trouble, not on the absence of "connected".** A listener can be healthy without ever reporting "connected": for example, when it attaches to an event stream that another process already opened, it may never print the line that sets that state, and sit at "starting" while working fine. A rule like "anything not connected for ten minutes is a disconnect" then alerts for nothing, and an alarm that is often wrong gets ignored.
- **No state file means no judgement**, not an alarm. Otherwise the watcher pages you during a fresh install.
- **Pause the watcher before a planned stop**, and resume it after. This belongs in your Stop cell, or every deliberate stop becomes a false alarm.

**To verify it on your setup:** stop the bridge for longer than the frozen threshold (six minutes against a five-minute rule) and expect exactly one "down" alert; start it again and expect exactly one "recovered" alert; then run a long normal job and expect no alert at all. Do the same for layer 3 if you turn it on: the service's alert, not its dashboard, is the thing to see.

This is still half an answer. The watcher runs on the same machine, so it dies with the machine.

## Layer 3: outside the machine

Two shapes, both cheap:

1. **A dead-man's switch.** The bridge pings a URL on a schedule; a service on the internet expects that ping and alerts you when it stops arriving. Services of this kind exist (some are open source and can be self-hosted on a second machine); pick one you trust. `bridge/heartbeat.mjs` has an optional outside ping, **off by default**; you give it a URL to turn it on (see the file for the setting's name).
2. **A daily "alive" line** that the bridge sends you at a fixed time. Its absence is the alarm. Weaker, because you have to notice something missing, but it needs no extra service.

One design point either way: **tie the ping to the bridge's health, not to an independent timer.** A ping from a loop that keeps running while the bridge is deaf tells the outside world "alive" about a bridge that is not working. The reference sends the ping only while `connection` is `listening`, so a bridge that has lost either listener goes quiet to the outside and the service notices. That also means a listener that sits in `starting` stops the ping; if your listener can stay in `starting` while healthy (see the watcher rule above), change that condition before you trust the ping. It still pings while a job is stuck past its deadline; layer 2 catches that one. If you have no layer 2, make the ping skip a job past its deadline too.

Decide and write down the delay: "alerts within 15 minutes of the machine going silent" is an answer; "the service will tell me" is not.

## The honest answer when you have no layer 3

Many setups will not have an outside heartbeat on day one. That is fine, as long as the cell says so:

> Heartbeat: state file and same-machine watcher only. Hole: a dead machine is invisible.

**That sentence is a legal answer. A blank cell is not.** Written down, it tells you what to check after a power cut, and it tells anyone reading the sheet what the bridge cannot promise.

## The cell finds more than heartbeats

Asking "who outside the machine notices" makes you trace what depends on the machine, and that trace often finds dependencies nobody wrote down: another device or service that depends on the machine, a job elsewhere that reads its output, a person who expects its daily message. When the machine goes, each of those fails silently too. Write them into the cell; the fix is usually small once the dependency is named.

---

## Checklist lines this chapter adds

- [ ] State file written atomically every 60 s, carrying the current job's deadline, the overall `connection` and each listener's state.
- [ ] A same-machine watcher alerts once per incident and once on recovery, through a path that does not depend on the bridge.
- [ ] The watcher alarms only on states that mean trouble; a missing state file is no judgement.
- [ ] Planned stops pause the watcher first (written in the Stop cell).
- [ ] Heartbeat cell names who outside the machine notices and within how long, **or** reads "only on-machine; a dead machine is invisible". Never blank.
- [ ] If an outside ping is on, it stops when the bridge is deaf (and, without a layer 2, when a job is stuck).
