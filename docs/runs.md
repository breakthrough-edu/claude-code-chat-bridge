# Runs: progress, the Stop button, slow vs stuck, and limits

*What happens between the moment a message arrives and the moment the reply goes out: show it, let yourself stop it, tell "slow" from "stuck", and put a number on everything that can run away. The Limits part is cell 4 of [the eight cells](eight-cells.md).*

Written against Claude Code 2.1.240 (September 2026). The code blocks below are the short, teaching versions; the files in `bridge/` are the truth if they ever disagree.

---

## Show progress, and let yourself stop it

A real task spends most of its time in tool calls *before* the first word of the reply, so streaming the reply text alone shows a blank card and then a wall of text. Stream **what it is doing** instead: one short line per tool call.

```js
// Called once per parsed stream-json line.
function progressLine(ev) {
  if (ev.type !== 'assistant') return null;
  for (const b of ev.message?.content || []) {
    if (b.type !== 'tool_use') continue;
    if (b.name === 'Read')  return `📖 reading ${basename(b.input.file_path)}`;
    if (b.name === 'Write') return `✍️ writing ${basename(b.input.file_path)}`;
    if (b.name === 'Edit')  return `✏️ editing ${basename(b.input.file_path)}`;
    return `🔧 ${b.name}`;
  }
  return null;
}
```

The version the bridge runs is `progressLine` in `bridge/loop.mjs`.

Show the last few lines on **one message that updates in place**, not a new message per step. On Lark that is a CardKit card entity:

| Step | Lark call |
|---|---|
| Create the card | `POST /open-apis/cardkit/v1/cards` with `{type:"card_json", data:<Card 2.0 JSON>}`. |
| Send it | send an `interactive` message whose content is `{"type":"card","data":{"card_id":"..."}}` |
| Update it | `PUT /open-apis/cardkit/v1/cards/{card_id}` with the **whole card** re-rendered and a `sequence` number. `sequence` must increase on every call (Lark's API requires it). Throttle to about one update a second. |
| Finish | the same whole-card `PUT`, with the final text and **no Stop button**. |

This is what the reference bridge does: every update, including the last, re-renders and sends the whole card (`updateCard` in `bridge/platform-lark.mjs`, throttled by `CARD_UPDATE_MIN_MS` in `bridge/loop.mjs`). Your app needs the `cardkit:card:write` scope.

An option the reference does not use: CardKit's streaming mode. Create the card with `config.streaming_mode: true` and an `element_id` on the text element, then update only that element with `PUT /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content` and `{content, sequence}`. Each update is smaller, but the finish must still re-render the whole card with `streaming_mode: false` and no Stop button: updating only the text leaves a live-looking Stop button on a finished card forever.

Other platforms: Slack `chat.update` and Telegram `editMessageText` give you the same edit-in-place pattern.

### The Stop button

**The Stop button** is a card button with a callback value like `{kind:"stop", job:<id>}`:

- Subscribe to `card.action.trigger`. ⚠️ On Lark this callback is **not** included in the one-click app setup preset, so until you add it, taps do nothing. The card listener's error prints a launcher link that adds just this callback: open it and approve, and the bridge's retry picks the listener up with no restart ([lark-setup.md](lark-setup.md#3-what-the-new-app-does-out-of-the-box-and-the-one-thing-it-lacks)).
- Handle the tap **directly in the callback**, not through your message queue. The queue is busy running the very job you are trying to stop.
- Gate the tapper exactly like the sender: only your own user id may press it.
- Depending on your client library, the callback's action value may arrive as a JSON **string**. Parse defensively.

The same callback path carries the approval card's buttons; see [approval-card.md](approval-card.md).

### Stopping must kill the whole tree

`claude` starts hooks, tools and shells of its own. Because you spawned it `detached` (README §5), it has its own process group:

```js
function stop(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  // A grandchild that started its own session can keep stdout/stderr open after the group dies,
  // and your 'close' handler waits for those pipes. Force them shut a second later.
  setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 1000);
}
```

The full version is `killGroup` in `bridge/run-claude.mjs`.

Without the second step, a stopped run can still hold the queue: a grandchild keeps the pipes open, so the `close` handler never fires.

**Clean up after your own crash.** Because the child is `detached`, it does not die when the bridge does. If the bridge crashes or restarts mid-run, the old `claude` group keeps running with nobody listening. Record the child's pid in the state file (below, and [heartbeat.md](heartbeat.md)), and on startup kill any recorded group that is still alive. On a clean shutdown (SIGTERM), stop the running job before you exit.

A run killed halfway may already have written half of what it meant to write. What the bridge does about that on the next start (and what it must not do, which is rerun the job blindly) is in [identity.md](identity.md).

Stopping a run is not stopping the worker. Stopping the worker for good, so it stays stopped after a reboot or a re-login, is in [launchd.md](launchd.md#stop-it-for-good).

---

## Tell "slow" from "stuck"

A fixed timeout is the wrong tool. Set it at 15 minutes and a genuinely long job gets killed at 15:01, while a hung one leaves you waiting the full 15 minutes with no word. Use a **silence watchdog** instead, with a generous hard cap behind it as the last backstop.

- Re-arm a timer on **every** stream event.
- **Pause** it while a tool call is open: a `tool_use` has been seen and its matching `tool_result` (same id, in a `user` event) has not arrived yet. A long shell command or sub-agent is work, not silence.
- If the timer fires (a 5 minute silence window is a sensible default), kill the process group and say so plainly in the chat and on the card. The reference bridge says "No activity for 5 minutes, stopped."
- Keep a hard cap (45 minutes is a sensible default) for the one case the watchdog cannot see: a tool that never returns.

```js
function makeIdleWatch(idleMs, onIdle) {
  const open = new Set(); let t = null;
  const arm = () => { clearTimeout(t); t = open.size ? null : setTimeout(onIdle, idleMs); };
  return {
    feed(ev) {
      for (const b of ev.message?.content || []) {
        if (ev.type === 'assistant' && b.type === 'tool_use')  open.add(b.id);
        if (ev.type === 'user'      && b.type === 'tool_result') open.delete(b.tool_use_id);
      }
      arm();
    },
    start: arm,
    stop() { clearTimeout(t); },
  };
}
```

The full version is `bridge/idle-watch.mjs`.

Call `start()` right after spawning, `feed()` on every parsed line, and `stop()` when the `result` event arrives **and** when the process closes, or a timer left over from a finished run can fire later.

Two details that matter:

- `--include-partial-messages` (README §5) is what keeps this honest. Without it, a model writing a very long answer produces no events for minutes and looks stuck. With it, text arrives as it is written.
- Before trusting the numbers, replay some of your real session transcripts (`~/.claude/projects/<project>/*.jsonl`) through the same logic and look at the longest gap with no tool open. Test it against what your agent actually does, not against fixtures you wrote by hand. `scripts/replay-transcripts.mjs [dir|file...]` does this replay for you; read its numbers as upper bounds, for the reasons in [gotchas.md](gotchas.md) #22.

Do not try to prove the watchdog by asking the bot to sleep; see [gotchas.md](gotchas.md) #9.

**Acknowledge queued messages.** If you process one message at a time, a message that arrives mid-run otherwise waits in silence. When the bridge is busy, reply at once. The reference bridge says "Got it. 1 task ahead of yours; I'll pick this up next."

**Make it observable from outside.** Write a small state file every 60 seconds (timestamp, current job and its deadline, connection state) and have a separate launchd job alert you if the timestamp goes stale or a job overruns its deadline. The bridge cannot report its own death. Both of those live on the same machine as the bridge, so a machine that is off or offline takes them down too; the third layer, outside the machine, is the Heartbeat cell in [heartbeat.md](heartbeat.md).

---

## Limits: put a number on everything that can run away

The watchdog and the hard cap bound one run. They do not bound the send call that hangs after the run finished, the retry loop that posts the same reply again and again, or a sender (or a script someone points at your bot) that fires a burst of messages. The Limits cell asks for all of them, each as a **named constant** you can find and change in one place, never a number buried in a call. In the reference implementation they are the `LIMITS` object at the top of `bridge/loop.mjs`; the file is the truth if this table and the code disagree.

The values are defaults, not measurements; change them to fit how you use the bot. **Untested on your setup:** verify with the offline suite (`npm test`, which runs `node --test bridge/test/*.test.mjs`), then read your own log after the first week of real use and check which limits fired.

| Limit | Name in `LIMITS` | Default | Why it exists |
|---|---|---|---|
| Silence watchdog | `IDLE_MS` | 5 minutes | tells "stuck" from "slow" (above) |
| Hard cap | `HARD_CAP_MS` | 45 minutes | the one case the watchdog cannot see: a tool that never returns |
| Inbound message length | `MAX_MESSAGE_CHARS` | 4,000 characters; longer messages are refused, not cut | [CHECKLIST.md](../CHECKLIST.md) asks for a cap; a pasted novel is not a request, and every character is prompt injection surface |
| Reply length | `MAX_REPLY_CHARS` | 8,000 characters; longer replies are cut with a note saying so | chat apps have their own limits, and a reply that silently fails to send looks like a dead bot |
| Waiting jobs | `MAX_QUEUE` | 5; beyond that, new messages are refused with a reason | a queue with no end hides a bot that has fallen behind |
| Send timeout | `SEND_TIMEOUT_MS` | 60 seconds, for every send and card update | a send with no timeout of its own can hang and hold the whole queue, and the watchdog is not watching it: the run already finished |
| Retries and backoff | `SEND_RETRIES`, `RETRY_BACKOFF_MS` | 2 retries, waiting 2 seconds and then 4 | a network blip should not lose the reply; an unbounded retry loop should not post it again and again |
| Sends per run | `MAX_SENDS_PER_RUN` | 6 messages and cards per job | a run that loops, or a model told to "send this to everyone", hits a wall instead of the chat |
| Per-sender rate | `RATE_WINDOW_MS`, `RATE_MAX_PER_WINDOW` | 20 messages per sender in 10 minutes | a stuck client, a forwarding rule or a script can flood you; each accepted message is a full `claude -p` run with a fixed cost (see [other-stacks-and-cost.md](other-stacks-and-cost.md)) |
| Queue acknowledgement | (behaviour, not a number) | reply at once (above) | silence is a bug |

Three rules for using the table:

- **A retry is a second write.** If a send timed out, the message may still have been delivered, and a retry can post it twice. The reference bridge gives every logical send one key (job id plus the kind of message) and passes it to the platform as an idempotency key on every attempt, so the platform has what it needs to drop the repeat. The wider rule, a stable id for every write that leaves the box, is the Identity cell in [identity.md](identity.md).
- **Say it when a limit fires.** A refused message gets a one-line reply saying which limit it hit; a send that fails after its retries, or a job that runs out of its send budget, gets a log line (the chat cannot be told what could not be sent). A limit that fires silently looks exactly like a dead bot.
- **Write the numbers into your Limits cell**, in [EIGHT-CELLS.md](../EIGHT-CELLS.md). If you cannot say what one of them is, that is the hole.

---

## Checklist lines this chapter adds

- [ ] Progress card shows one line per tool call and updates in place; the finished card is re-rendered whole with no Stop button.
- [ ] `card.action.trigger` added through the launcher link in the card listener's error, and `[event] ready` seen for it; Stop taps handled in the callback, not the queue, and gated by the same user allowlist.
- [ ] Child spawned `detached`; Stop and timeouts kill the **process group** and force the pipes shut; leftovers from a crash are killed on startup.
- [ ] Silence watchdog plus a hard cap; the chat is told plainly when a run was stopped.
- [ ] Watchdog numbers checked against a replay of your own transcripts, not only hand-written fixtures.
- [ ] Queued messages acknowledged at once.
- [ ] State file written every 60 seconds and watched by a separate job.
- [ ] Every limit is a named constant with its value written in the Limits cell: send timeout, retries and backoff, sends per run, per-sender rate, inbound and reply length, queue size.
- [ ] Every send carries a stable key reused across its retries.
- [ ] A refused message is told which limit it hit; every other limit that fires leaves a log line.
