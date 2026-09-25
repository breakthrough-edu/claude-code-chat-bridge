# Rollback: which backup, which records, which version

*Cell 8 of [the eight cells](eight-cells.md). Which backup to put back, which records to delete, and what "current version" means.*

Written 2026-09-25 against Claude Code 2.1.240. On another version, run the probes in [proof.md](proof.md) first. `scripts/backup.sh` is the reference helper; the script is the truth for its exact arguments and output. A restore you have never tried is unverified on your setup: the checklist at the end includes trying one.

---

## Before every change: a dated backup with its md5

Before you edit a file the bridge runs from, copy it next to itself with a label and the date, and note its md5:

```bash
scripts/backup.sh bridge/bridge.mjs watchdog
# makes bridge/bridge.mjs.bak-watchdog-<YYYY-MM-DD> and prints the md5 of both copies
```

The label says **which change this backup comes before**, not what the file is. `bak-watchdog` means "the version before the watchdog was added". Keep the md5 in your notes next to the label. It is how you prove later that the copy you restore is the one you meant, and that nobody (you included) edited the backup since.

Back up everything the change touches, not just the main file: a helper module, the plist, and **the state files if the change alters their format**. Restoring code that reads the ledger one way on top of a ledger written the other way is a new outage, not a rollback.

## "Current version" means "after which backup"

Write the current version of the bridge as the backup it came after:

> Current version = after `bridge.mjs.bak-stopbutton-<date>` (md5 `3f2a9c1e…`).

Why this shape: on a busy day you make several changes to the same file. Each backup is the state after the previous change, so they form a chain. "After which backup" tells you exactly which copy undoes only the last change, and which one undoes the last two. A version number or a date alone does not.

Two things that are **not** the current version:

- **What is in git.** Only if the running copy is the committed one. A bridge edited in place on the always-on machine drifts from the repo quietly.
- **What passed the tests.** A version that was tested is not necessarily the one that is running. Check the running file's md5, or restart and check the startup line.

## Restoring

1. Copy the backup back over the file.
2. Check its md5 against the one you noted.
3. Restart the bridge (a `/restart` chat command handled before Claude, or `launchctl kickstart -k`; see [launchd.md](launchd.md) for when kickstart is not enough).
4. Run the proof again ([proof.md](proof.md)): the cage check from a real run, and whatever the change was supposed to prove. A rollback is a change too.
5. Update the notes: current version = after the backup you just restored, or "restored to before X".

## Which records to delete

Code comes back with a copy. Things the bridge wrote to the world do not. For each change, the Rollback cell lists the records it could have produced: rows in a table, files outside the working directory, posts. Your ledger and the stable ids from [identity.md](identity.md) are how you find them. In the reference bridge, a carded write is recorded in the approval store (`approvals.json` in the state folder), where each `done` draft names the file it wrote.

Deleting is a human's decision. The bridge never deletes its own suspected mistakes; it lists them where you will see them.

## What cannot be rolled back

Write these down explicitly, because they decide whether an action needs an [approval card](approval-card.md) (test 3: it cannot be undone):

- **Messages already sent.** The reference bridge has no recall; treat a sent message as permanent.
- Anything other people have already read or acted on.
- Files the model edited inside the working directory, **unless** that folder is under version control. If you want those reversible, put the working directory under git and commit before you let the bridge loose on it.

## Published copies do not resync

**Changing the source does not update copies that were already published.** Fixing the value in one place feels like fixing it everywhere. It is not.

The mechanism: copies already published elsewhere do not update when the source changes. Each copy was made from the source at one moment and has no link back to it, so a value fixed in the source stays wrong in every copy made before the fix. Nothing errors, and the stale copy is usually the one other people read, so the wrong value stays live exactly where it does the most harm until someone finds it by eye.

For a bridge, the published copies are things like:

- **the plist's `EnvironmentVariables`**, which is a copy of your config (the working directory, the path to `claude`). Change the config file and the running bridge still has the old value until you edit the plist and re-register it.
- **cards already sitting in chats.** A new card template does not repaint old cards. An old card with a live button is still live.
- **a pinned message** or a help text you posted once.
- **a copy of the bridge on another machine.**

So after any change to a value that has copies: list every copy, fix them nearest to readers first (public, then other people, then yourself), and check each one by eye against the source, not against another copy.

---

## Checklist lines this chapter adds

- [ ] A dated `.bak-<label>-<date>` backup with its md5 noted before every change, state files included when their format changes.
- [ ] "Current version = after backup X" written down and checked against the running file's md5.
- [ ] Restore procedure tried once: copy back, md5 match, restart, proof rerun.
- [ ] Rollback cell lists what cannot be undone (sent messages at least); each of those actions reviewed for an approval card.
- [ ] After changing a source value, every published copy (plist env, live cards, pinned text, other machines) listed and fixed.
