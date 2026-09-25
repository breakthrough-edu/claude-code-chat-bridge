# Other stacks, and what it costs

*Porting the bridge to another chat app, to Linux, or to an API key; and what a headless run actually costs on a subscription.*

Written against Claude Code 2.1.240 (September 2026). No token figures are given here, because they vary with CLI version, tool set and settings; the section on where the tokens go says how to measure your own.

---

## Adapting to other stacks

- **Other chat apps:** Slack (Socket Mode), Telegram (long polling), Discord (gateway) all give you the same outbound-connection-no-inbound-port model. Reimplement the five functions of the platform interface in `bridge/platform.mjs` (`consumeMessages`, `sendMessage`, `sendCard`, `updateCard`, `onCardAction`), using the platform's edit-in-place call for `updateCard` ([runs.md](runs.md#show-progress-and-let-yourself-stop-it)); everything else is unchanged. In the reference implementation that means writing one new platform file next to `bridge/platform-lark.mjs`.
- **Linux / systemd** instead of launchd: there's no TCC, so gotchas #3, #5 and #7 disappear (see [launchd.md](launchd.md)), but you still must set `WorkingDirectory`, a clean `Environment=` (with `USER` and `SHELL`), and `Restart=always`, and make sure the service user can reach your credentials.
- **API key instead of a subscription:** set `ANTHROPIC_API_KEY` in the service env and skip the OAuth gotcha; just remember it now bills per token.

---

## Cost / billing note

On a subscription, the `total_cost_usd` figure in `claude -p`'s output is an **estimate, not a charge**: usage counts against your plan's limits, shared with your interactive Claude Code and web usage. A chatty bot eats the same budget as your real work, so pick a fast model for dispatch and use a "new conversation" reset to keep threads short.

Because that dollar figure is notional on a subscription, do not put it on a dashboard or in a notification: a number that looks like spend will steer your decisions even though nothing was charged. Log tokens and seconds instead.

## Where the tokens go: the fixed overhead is the bulk

Every `claude -p` run rebuilds Claude Code's own system prompt and tool definitions before it reads a word of your message. For a bot answering chat messages, that fixed per-run overhead usually dominates: it is paid **per run**, and it is often far larger than the message and context you send. Cutting your own prompt in half can therefore move the per-run total much less than you expect.

**Measure your own.** The `result` event of every run carries a `usage` object. Log its input, cache creation, cache read and output token counts for a handful of real runs, next to the size of the prompt you sent. That split tells you where your tokens actually go. Untested on your setup until you have done this.

Two consequences:

- **Savings come from fewer runs, not shorter prompts.** Debounce bursts of messages into one run, ignore what the allowlist would reject before `claude` starts, and put a cheap check in code in front of the model where a rule can answer. The per-sender rate limit in [runs.md](runs.md#limits-put-a-number-on-everything-that-can-run-away) is a cost control as much as a safety one.
- **The cache does not carry you between runs spaced out in time.** The prompt cache expires after about five minutes, so runs spaced further apart than that pay for the fixed part again every time, and `usage` shows it as cache *creation*, not as a cache *read*. If you see high cache creation and low cache reads, stop expecting the cache to save you.

Before you estimate a saving, split one run's usage into four parts: Claude Code's own prompt and tools, what you send, what the model writes, and extra turns. Only the second and third are yours to shrink, so check which is biggest first. And when you report a saving, say whether it is "the part you control fell by half" or "the total fell by half"; they are different sentences.

---

## Checklist lines this chapter adds

- [ ] On another chat app: the five platform functions in `bridge/platform.mjs` reimplemented; nothing else changed.
- [ ] On Linux: `WorkingDirectory`, a clean `Environment=` with `USER` and `SHELL`, `Restart=always`, credentials reachable by the service user.
- [ ] Dashboards and notifications show tokens and seconds, never `total_cost_usd`.
- [ ] One run's usage split into its four parts before any cost-saving work; savings sought in fewer runs first.
