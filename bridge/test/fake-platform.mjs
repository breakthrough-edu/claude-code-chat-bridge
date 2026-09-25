// An in-memory platform for tests: implements the full interface in platform.mjs,
// records every send and card update, and lets a test inject messages and card taps.

export function createFakePlatform() {
  let onMessage = null;
  let onAction = null;
  let cardSeq = 0;
  let msgSeq = 0;
  const sent = [];                  // { target, text, idempotencyKey }
  const cards = new Map();          // cardId -> { target, history: [card, ...] }
  const waiters = [];
  const failNext = { send: 0 };     // make the next N sends throw, to test retries

  const notify = () => {
    for (const w of waiters.slice()) {
      if (w.pred()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
    }
  };

  const platform = {
    consumeMessages(handler, { onState } = {}) {
      onMessage = handler;
      onState?.('listening');
      return { close() { onMessage = null; onState?.('closed'); } };
    },

    async sendMessage(target, text, { idempotencyKey } = {}) {
      if (failNext.send > 0) { failNext.send--; throw new Error('fake send failure'); }
      // Honour idempotency keys the way the real API does: a repeat is not a second message.
      if (idempotencyKey && sent.some((s) => s.idempotencyKey === idempotencyKey)) return { messageId: 'dup' };
      sent.push({ target, text, idempotencyKey });
      notify();
      return { messageId: `om_fake_${++msgSeq}` };
    },

    async sendCard(target, card) {
      const cardId = `card_fake_${++cardSeq}`;
      cards.set(cardId, { target, history: [structuredClone(card)] });
      notify();
      return { cardId, messageId: `om_fake_${++msgSeq}` };
    },

    async updateCard(cardId, card) {
      const c = cards.get(cardId);
      if (!c) throw new Error(`no such card ${cardId}`);
      c.history.push(structuredClone(card));
      notify();
    },

    onCardAction(handler) {
      onAction = handler;
      return { close() { onAction = null; } };
    },
  };

  return {
    platform,
    sent,
    cards,
    failNext,

    inject(msg) {
      if (!onMessage) throw new Error('nobody is consuming messages');
      onMessage({ chatType: 'p2p', messageType: 'text', mentions: [], ...msg });
    },

    tap(action) {
      if (!onAction) throw new Error('nobody is listening for card actions');
      onAction(action);
    },

    lastCard() {
      const all = [...cards.values()];
      const c = all[all.length - 1];
      return c ? c.history[c.history.length - 1] : null;
    },

    // Wait until pred() is true, re-checked on every send or card change.
    waitFor(pred, timeoutMs = 5000) {
      if (pred()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); reject(new Error('waitFor timed out')); }
        }, timeoutMs).unref();
      });
    },
  };
}
