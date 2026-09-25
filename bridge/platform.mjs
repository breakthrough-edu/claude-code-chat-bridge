// The platform interface: the only place the rest of the bridge touches a chat app.
//
// Implement these five functions for your chat app and nothing else changes.
// platform-lark.mjs is the Lark implementation; test/fake-platform.mjs is an in-memory
// one the tests drive. A Slack, Telegram or Discord version needs the same five.

/**
 * An inbound chat message, already normalised by the platform.
 * @typedef {Object} InboundMessage
 * @property {string} eventId     The platform's dedupe key for this message. It is persisted
 *                                (ledger.mjs), so pick the id that stays the same when the
 *                                platform redelivers. On Lark that is message_id, not event_id.
 * @property {string} userId      Sender id (Lark: open_id, per app; see docs/sessions-and-groups.md).
 * @property {string} chatId      Chat the message came from.
 * @property {'p2p'|'group'|string} chatType
 * @property {string} messageType 'text' for plain text; anything else is ignored by the bridge.
 * @property {string} text        Message text with @-mention placeholders removed.
 * @property {Array<{id: string, name?: string}>} mentions  Who was @-mentioned.
 */

/**
 * Where a message or card goes. Exactly one of the two.
 * @typedef {{chatId: string} | {userId: string}} Target
 */

/**
 * A platform-neutral card. The platform renders it into its own card format.
 * @typedef {Object} Card
 * @property {string} title
 * @property {string} markdown     The body. For a progress card, the last few progress lines.
 * @property {Array<CardButton>} [buttons]  Omit or leave empty on a finished card, so no
 *                                 live-looking button is left behind.
 */

/**
 * @typedef {Object} CardButton
 * @property {string} text
 * @property {Object} value        Sent back verbatim in the CardAction. Keep it small and
 *                                 self-describing, e.g. {kind: 'stop', job: 'job-123'}.
 * @property {'default'|'primary'|'danger'} [type]
 */

/**
 * A tap on a card button.
 * @typedef {Object} CardAction
 * @property {string} eventId      Unique per tap; used to drop redeliveries.
 * @property {string} operatorId   Who tapped. Same kind of id as InboundMessage.userId, so the
 *                                 same allowlist gates senders and tappers.
 * @property {string} [chatId]
 * @property {string} [messageId]  The card message that was tapped.
 * @property {Object} value        The button's value, already parsed. Some platforms deliver
 *                                 it as a JSON string; the platform parses it, defensively.
 */

/**
 * @typedef {Object} SendOptions
 * @property {string} [idempotencyKey]  Stable key for this send. If a send times out and is
 *                                 retried, the platform uses it to drop the duplicate
 *                                 (Lark: --idempotency-key, max 50 characters).
 */

/**
 * @typedef {Object} Subscription
 * @property {() => void} close
 */

/**
 * @typedef {Object} Platform
 * @property {(onMessage: (msg: InboundMessage) => void, opts?: ListenerOptions) => Subscription} consumeMessages
 *           Start streaming inbound messages.
 * @property {(target: Target, text: string, opts?: SendOptions) => Promise<{messageId?: string}>} sendMessage
 *           Send markdown text.
 * @property {(target: Target, card: Card, opts?: SendOptions) => Promise<{cardId: string, messageId?: string}>} sendCard
 *           Send a card that can be updated later by cardId.
 * @property {(cardId: string, card: Card) => Promise<void>} updateCard
 *           Replace the whole card. Re-render everything, including removing buttons when done.
 * @property {(handler: (action: CardAction) => void, opts?: ListenerOptions) => Subscription} onCardAction
 *           Stream card button taps.
 */

/**
 * Options for both listeners. The platform restarts a listener that drops, with backoff.
 * @typedef {Object} ListenerOptions
 * @property {(state: 'listening'|'down'|'closed') => void} [onState]  Listener health, for the
 *           heartbeat. 'down' means it dropped and a restart is pending.
 * @property {(message: string) => void} [onFatal]  Called once when a restart cannot help
 *           (for example the app is disabled). No restart follows; the bridge should exit
 *           non-zero so launchd and whoever reads the log notice.
 */

export const PLATFORM_METHODS = ['consumeMessages', 'sendMessage', 'sendCard', 'updateCard', 'onCardAction'];

// Fail at startup, not at the first message, if an implementation is missing a method.
export function assertPlatform(p) {
  const missing = PLATFORM_METHODS.filter((m) => typeof p?.[m] !== 'function');
  if (missing.length) throw new Error(`platform is missing: ${missing.join(', ')}`);
  return p;
}
