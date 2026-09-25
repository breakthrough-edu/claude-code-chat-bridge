# Build or adopt?

*Whether to build the bridge by hand, as this guide does, or start from a maintained project; and what to check in any project that relays Claude's permission prompts into the chat.*

Written against Claude Code 2.1.240 (September 2026). The comparison is as described in each project's README and code as of September 2026; check their current defaults. **Untested on your setup:** verify each project's defaults yourself before you connect it to anything. The relay traps below are a checklist to check a relay against.

---

## The options

This guide builds the bridge by hand because the security decisions in README §5 are the point, and a hand-built bridge lets you add the odd capability your life needs (voice notes, a video pipeline, a morning briefing). If you would rather start from something maintained, these were the serious options as described in each project's README and code as of September 2026; check their current defaults before you rely on them.

| Project | What it is | Good at | Watch out for |
|---|---|---|---|
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) (Go, ~15.6k stars) | One bridge for 10+ coding agents across 13 chat apps, Feishu/Lark included | Streaming cards, **Allow/Deny approval buttons mid-turn** (it relays Claude's permission prompt into the chat), per-chat sessions, `/stop`, cron | In the published config, the allow lists default to `"*"`: open to everyone until you lock them down. No timeout on pending approvals was visible in the code. Large codebase to own. No LICENSE file was visible as of 2026-09-24; confirm before depending on it. |
| [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (TypeScript, ~2.5k stars, MIT) | A Lark-only bridge built on the official Channel SDK (`@larksuite/channel`) | The safest defaults of the three: only the app owner until you `/invite`, strangers get silence. Idle watchdog, batching of mid-run messages, doc-comment replies | No mid-turn approvals (three fixed permission levels). |
| [Claude Code Channels](https://code.claude.com/docs/en/channels) (Anthropic) | Official way to push chat messages into a running session | First-party, permission relay to chat | Research preview; official plugins are Telegram, Discord and iMessage. No Lark/Feishu plugin. |

Two things none of them change: the per-app `open_id` trap ([sessions-and-groups.md](sessions-and-groups.md#groups)), and the need to decide your own security model. Read their permission defaults before you connect them to anything that matters.

Whichever you pick, fill [the eight cells](eight-cells.md) for it before you connect it to anything. Adopting a bridge does not adopt its answers: its Stop, Heartbeat and Rollback cells are still yours to fill.

---

## Mid-turn approval: a relay, or a card?

Two of the options above can relay Claude's own permission prompt into the chat: the run pauses when the model reaches for a tool that needs approval, you get Allow and Deny buttons, and the run continues on your tap. It is a real option. It is not this guide's default, for two reasons:

- **A bot that asks before every step is a bot you stop using**, or one whose buttons you tap without reading. Either way the approval stops meaning anything.
- **Pinning a tool call is weaker than pinning content.** What matters is what lands where other people can see it (the message sent, the row written, the file published), not which tool wrote it. A relay shows you "Write, path X"; a card shows you the exact text or every field's value, and then the program writes exactly that.

This guide's default is the [approval card](approval-card.md): at the boundary where a write becomes visible to others, touches money, cannot be undone, or carries values the model generated, the program pins the full content on a card and executes that pinned content when you tap. The model is not asked again.

If you adopt a relay anyway, or build one, check it for these traps. Each row is the thing to look for and what to do instead.

| Trap | Why it bites | Do the opposite |
|---|---|---|
| **No timeout on a pending approval** | The run holds its process, its session and (in a one-at-a-time bridge) the whole queue until someone taps. A card you did not see at night is a bot that is dead until morning. | Give every pending approval a timeout (minutes, not hours). On timeout, count it as **deny**, repaint the card as "timed out, not done", and tell the model in the denial what was not done, so its reply says what you would need to approve. |
| **Buttons that carry no request id** | An old card still on screen can approve whatever request is pending *now*, which is not the one it showed. | Put the job id, the request id and a one-time nonce in the button's value. Ignore any tap whose ids do not match the request currently waiting. |
| **A typed "ok" counts as approval** | Anything you type in the chat while a request is pending ("ok", "sure", a reply to something else) is read as consent. So is anything someone else types, if the relay does not check the sender. | Only the button counts. Typed text is a new message, never an answer to a pending approval. |
| **"Approve all" lasts the life of the process** | One tap early in the week approves every later request of that kind until the next restart, long after you forgot you pressed it. | Scope any "approve all" to the one run it was pressed in; the next run starts from zero. |
| **The card stays live after a tap** | A second tap, or a second person's tap, runs the action again. | Claim the pending request atomically on the first tap, repaint the card to its final state, and remove the buttons. The repaint stops one person double-tapping; the atomic claim is what stops two people at once. |
| **The relay never fires** | If a global setting or a merged `--settings` file (gotcha #4 in [gotchas.md](gotchas.md)) already approves the tool, the CLI never asks, the relay never shows a card, and nothing errors. | Prove it from the runtime: read `permissionMode` in the `system/init` event (README §5) and trigger one real request on purpose before you trust it. |

Tap handling for any card, relay or not: gate the tapper with the same allowlist as the sender, and parse the callback value defensively, because it may arrive as a JSON string ([runs.md](runs.md#the-stop-button)).

One more thing to verify before you build a relay yourself: the `--permission-prompt-tool` flag that relay code passes to the CLI to receive permission prompts is not listed in `claude --help` on Claude Code 2.1.240. Treat it as internal and liable to change; verify with `claude --help` on your version, and again after every CLI upgrade.

---

## Checklist lines this chapter adds

- [ ] If adopting: the project's permission defaults and allowlists read and locked down before it is connected to anything; its eight cells filled.
- [ ] If adopting: license confirmed.
- [ ] Any mid-turn relay has a timeout that counts as deny, buttons carrying the request id and a nonce, button-only approval, "approve all" scoped to one run, and cards repainted spent after a tap.
- [ ] Any relay proved to fire with one deliberate real request, and `permissionMode` read from the init event.
