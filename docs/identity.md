# Identity: what happens when it runs twice

*Cell 3 of [the eight cells](eight-cells.md). For every write that leaves the box: the stable id, and what a rerun does.*

Written 2026-09-25 against Claude Code 2.1.240. On another version, run the probes in [proof.md](proof.md) first. The reference implementation is `bridge/ledger.mjs`; the file is the truth if this chapter and the code ever disagree. Until you have run the restart test below on your own setup, treat this behaviour as unverified there.

---

## Why this cell exists

A chat bridge sees the same thing twice more often than you would think: a platform can deliver an event again after a slow acknowledgement or a reconnect; the bridge restarts in the middle of a job; you get no reply and send the message again. "Exactly once" is not available over a network. What you can build is **at least once, plus a reliable way to recognise a repeat**.

Two ways it goes wrong, both silent:

- **The id is a filename, or the check is exit 0.** An input that changes name or content mid-run makes a filename or exit-code based check write the same thing twice. Files get renamed, re-uploaded and copied; a worker that keys on the name sees the changed file as new work and does it again, with exit 0 both times and no error anywhere.
- **The ids live in memory.** A set of handled message ids is empty after every restart. A job killed after it had already written something reruns in full when the same message arrives again, and writes twice.

The reference bridge closes the second one and is explicit about what it cannot close.

---

## Inbound: persist the ids you have handled

Keep handled message ids **on disk**, not in memory. A set in memory is empty after every restart, which is exactly when a redelivery is most likely. Bound the list so the file does not grow forever (the reference keeps the most recent ids up to `MAX_SEEN_IDS` in `bridge/ledger.mjs`, days of chat; the oldest fall off first). Write the file atomically: write a temp file, then rename it over the old one, so a crash mid-write cannot leave half a ledger.

**Pick the id that survives a redelivery.** A platform's delivery or event id can change when it delivers the same message again; the message's own id does not. On Lark that means `message_id`, not `event_id` ([gotchas.md](gotchas.md), the `message_id` entry). A list keyed on the delivery id lets the redelivered message through and runs the job twice. Card taps have no message of their own, so the reference keys them on the tap's event id.

Mark the id handled **before** acting on it. If the bridge dies mid-run, a redelivery of the same message must not start the same job again.

## The job ledger

Every accepted message becomes a job. Its state is written to disk **before** the step it names starts:

| State | Meaning | Found at startup, the bridge |
|---|---|---|
| `received` | passed the filters, waiting in the queue | marks it `dropped` and asks you to resend if you still want it |
| `running` | `claude` is about to be, or has been, spawned | **does not rerun it.** Marks it `interrupted` and tells you (below) |
| `replying` | the run is over and its outcome is known; the reply has not been confirmed sent | **does not rerun it.** Marks it `interrupted` and tells you the reply may not have reached you |
| `done` | the run succeeded and the reply send finished; `replyDelivered` records whether the send was confirmed | leaves it alone |
| `failed` | the run ended in an error; the reply saying so was sent (`replyDelivered` as above) | leaves it alone |
| `stopped` | you pressed Stop, the watchdog or hard cap stopped it, or the bridge was shutting down | leaves it alone |
| `interrupted`, `dropped` | set at startup by the rows above | leaves them alone |

`replying` exists so that "the work is done" and "you were told" are two separate facts on disk. Without it, a crash between writing `done` and sending the reply leaves a job that looks finished and a user who heard nothing.

Why not simply run a `received` job after a restart? Nothing has happened for it yet, so it would be safe. The reference asks instead because a restart can come hours later, and a request typed before a long outage may no longer be one you want run. Running it is a reasonable choice for your own bridge; write whichever you pick in the Identity cell.

The ledger also records the pid of the running `claude` child, so startup can kill an orphaned process group left behind by a crash (the child is detached and outlives the bridge; see [runs.md](runs.md)).

The one rule that carries this chapter: **a job found `running` or `replying` after a restart is never rerun automatically.** The bridge cannot know how far it got. The model may already have written a file or sent something through an action. Rerunning it is how the double write happens. Instead, send the user one line:

> The bridge restarted while working on "summarize my latest note". I did not rerun it, because it may have done part of the work already. Check, then send it again if needed.

(That is the reference bridge's wording, in `bridge/loop.mjs`; the "I" is the bot speaking.)

Now a rerun is your decision, made with the knowledge that it may double something, which is the only honest position the bridge can put you in.

**To verify it on your setup:** run the offline suite with `npm test` (not bare `node --test`, which also runs the test helpers as tests; see [gotchas.md](gotchas.md)). The restart scenario has the fake `claude` child emit a `Write` tool use, kills the bridge, restarts it, and checks that the orphan was killed, the job was not spawned again, and the interrupted notice was sent. Then do it once for real: send a slow request, kill the bridge process with `kill -9` mid-run, let launchd restart it, and check three things: the notice arrived; **no** `claude` process is left over (`pgrep -fl claude` shows none from the bridge, because startup killed the orphan); and the log shows `claude` started only once for that job.

---

## Outbound: a stable id for every write that leaves the box

"Leaves the box" means anything outside the bridge's own state files: a record in a table, a file outside the working directory, a message to someone else, a post. For each kind, write down in the Identity cell what its stable id is.

**A stable id stays the same however many times the same thing is retried.** Good ones:

- the source's own id (a message id, an order number plus vendor, an invoice number plus supplier)
- a fingerprint of the content, such as an md5 of the input file, **computed before the model sees it** (if the input changes mid-run, a fingerprint taken afterwards is of a different thing)
- for an approval card: the draft id plus a fingerprint of the pinned content (see [approval-card.md](approval-card.md))

**Never a filename.** Names change under you: renamed, re-uploaded, copied.

Then, for every write:

1. **Check before writing.** Look the id up in your own ledger, and in the target itself if the target can store it (a field on the record, a line in the file). Found with the same content: it is already done, skip it and say so.
2. **Same id, different content is an error, not an overwrite.** Stop, keep both versions, and tell a human. Silently overwriting is how a correction and a duplicate become indistinguishable.
3. **Write.**
4. **Read back.** Fetch the record by the id the target returned, or read the file back and compare. Only then mark it done. Exit 0 is not proof ([proof.md](proof.md)).
5. **Never delete a duplicate automatically.** Leave the evidence where a human will see it and let them decide.

## "Not applicable" is a legal answer

A worker that never writes outside its own folder answers the cell with "not applicable: never writes outside" and one line on how it avoids local duplicates, if it has any. That answer still counts, because writing it forces you to check that it is true. A typical one: "not applicable: writes only to its own local database; rows keyed by the source's message id with insert-or-ignore, so a repeat is a no-op."

## What the reference bridge does and does not cover

- Inbound message ids (card taps: the tap's event id) and job states are persisted (`bridge/ledger.mjs`).
- A `running` or `replying` job is not rerun after a restart; the user is told.
- The one carded action (`bridge/actions/write-outside.mjs`, run by `bridge/approval.mjs`) uses the program-made draft id as both its stable id and its file name, pins a sha256 fingerprint of what the card shows, claims the draft once, checks before writing, and reads back after. Its records live in the approval store, `approvals.json` in the state folder.
- **Not covered:** files the model edits inside the working directory have no stable id. If you resend a request after an interruption, the model does the work again. That is a named hole in [the example sheet](../examples/eight-cells-bridge.md), acceptable because those edits stay inside a folder you own and can review (put that folder under version control if you want them reversible).

---

## Checklist lines this chapter adds

- [ ] Handled inbound ids persisted to disk (atomic write, bounded list), keyed on the message's own id (Lark: `message_id`), not a delivery id; marked handled before acting.
- [ ] Job ledger with at least `received` / `running` / `replying` / `done` / `failed` / `stopped`, each written before the step it names; your choice for a leftover `received` job written in the Identity cell.
- [ ] After a restart, a `running` or `replying` job is **not** rerun; the user gets one line saying it was interrupted.
- [ ] Every write that leaves the box has a named stable id (never a filename) in the Identity cell.
- [ ] Check before write, read back after; same id with different content stops and alerts, never overwrites.
- [ ] No automatic deletion of suspected duplicates.
