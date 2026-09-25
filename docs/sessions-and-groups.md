# Sessions and groups

*Remembering a conversation across messages, and answering in a group chat without widening who can drive the bot.*

Written against Claude Code 2.1.240 (September 2026). The code block is the short, teaching version; `bridge/sessions.mjs` is the truth if they ever disagree.

---

## Session continuity

Keep a map of `conversation → session_id` so conversations remember context. For DMs the key is the user; for groups (below) use the chat id, so every group gets its own thread.

```js
const prior = sessions[key];                      // may be undefined
const { text, sessionId, isError } = await run(text, prior);   // --resume prior if present
if (!isError) sessions[key] = sessionId;          // persist to a small JSON file
sendMessage(target, text);
```

The full version, with the dead-resume retry below, is `bridge/sessions.mjs`.

Add a reset command: if the message is exactly `/new`, delete `sessions[key]` and reply "started fresh". Persist the map to disk so threads survive restarts.

### Only store a session id from a successful run, and handle a dead one

If a stored session's transcript has been cleaned up, `--resume <id>` prints `No conversation found with session ID` and then a `result` event with `is_error: true`, `num_turns: 0`, and the dead id echoed back as `session_id`. If you store that id again, every later message fails the same way until someone sends `/new`. So: only write `sessions[key]` when the result has `is_error: false`, and when you see `is_error && num_turns === 0` on a resumed run, retry once with no `--resume`.

---

## Groups

Answering in a group is a small change with two traps.

- **Groups may deliver every message to the bot, not only the ones that @-mention it**, depending on the scopes your app has. So "the bot only answers when mentioned" must be enforced **in your code**: check the mention list for your bot's own id before doing anything. That line is a privacy boundary, not an optimisation.
- **Keep the sender allowlist exactly as it is.** Groups widen *where* the bot can be reached, not *who* can drive it.
- **Optional, not implemented in the reference bridge:** when mentioned, pull the last N messages of the chat as context and label them in the prompt as **data, not instructions**: anyone in the group can type anything. The reference bridge sends only the message that mentioned it, and keeps one session per group chat.
- **Lark `open_id` is per app.** The same person has a different `open_id` under each bot app you create. If you build a second bot, re-resolve every id under that app or your allowlist will silently reject everyone. (`chat_id` is stable across apps, and Lark's `union_id` identifies a person across the apps of one developer; use it if you run several bots.)

The per-app `open_id` trap applies to the ready-made bridges too; see [build-or-adopt.md](build-or-adopt.md).

A group changes one of your eight cells: the Reads cell now includes messages written by people who are not you (the mentioning message, and the last N messages too if you add group context). Update it in [EIGHT-CELLS.md](../EIGHT-CELLS.md).

---

## Checklist lines this chapter adds

- [ ] Session ids stored only from successful runs; a dead `--resume` retries fresh.
- [ ] `/new` resets the thread; the session map is persisted to disk.
- [ ] Bot only answers **your own user id**; in groups, only when **@-mentioned**, enforced in code.
- [ ] If you add group context (not in the reference bridge): labelled in the prompt as data, not instructions.
- [ ] Every allowlisted id re-resolved under each new bot app (`open_id` is per app).
