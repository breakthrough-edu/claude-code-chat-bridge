// Lark / Feishu implementation of the platform interface (platform.mjs), built on lark-cli.
//
// Why lark-cli: it wraps the official long-connection event client, so the bridge dials
// OUT and needs no public webhook and no tunnel. Any SDK that does the same works; only
// this file would change.
//
// Configuration (environment):
//   LARK_CLI       absolute path to lark-cli. Under launchd PATH is minimal, so do not rely on it.
//   LARK_PROFILE   lark-cli profile to use. Set it whenever you have more than one app
//                  configured: two consumers on the same app split or double the events.
//
// Gotchas kept here because this is where they bite:
//   - The event stream command treats stdin EOF as "stop". Spawned with a closed stdin it
//     exits at once ("context canceled"). consume() below gives it a real stdin pipe and never closes it.
//   - Long connections do not replay missed events. Anything sent while nothing was
//     listening is gone. "The bot did not react" almost always means "the listener was not
//     running"; check that before anything else.
//   - Dedupe on message_id, not event_id: the event schema says the same message can be
//     delivered again under a new event_id.
//   - card.action.trigger is NOT in the one-click app setup preset. Add it in the developer
//     console yourself, or buttons do nothing.
//   - The tap's action value arrives as a JSON string. Parse it defensively.
//   - Every call passes `--as bot`. Without it the CLI may pick a user identity and the
//     message is sent as you, not as the bot.
//   - Card updates need the cardkit:card:write scope, and `sequence` must increase on every
//     update of the same card.
//   - open_id is per app: the same person has a different open_id under each bot app.
//   - A config problem (for example a disabled app: code 20069, "The specified app is not
//     enabled") makes the consumer print an error report and exit with code 3. The report is
//     PRETTY-PRINTED JSON over many lines, {"ok": false, "error": {"type": "config", ...}},
//     so it cannot be parsed line by line: findErrorReport() scans everything the consumer
//     printed once it has exited. Restarting cannot fix a config error, so after a few in a
//     row the platform reports it as fatal. Other exits are retried with backoff.
//   - "Listening" means the CLI printed its ready line ("[event] ready event_key=...") on
//     stderr, not merely that the process started: a consumer that is about to fail on a
//     config error has started too. Do not pass --quiet: it suppresses the ready line.

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export const SEND_TIMEOUT_MS = 60_000;                       // one lark-cli call, start to finish
export const RESPAWN_BASE_MS = 1000;                         // first restart delay, doubled each time
export const RESPAWN_MAX_MS = 30_000;                        // restart delay cap
export const FATAL_CONFIG_FAILURES = 3;                      // config failures in a row that are fatal
export const FATAL_WINDOW_MS = 60_000;                       // ...when they all fall within this window
const CONFIG_EXIT_CODE = 3;                                  // lark-cli's exit code for a config error
const KEEP_OUTPUT_CHARS = 64 * 1024;                         // per consumer start, for the error scan
const READY_RE = /\[event\] ready\b/;
const MAX_IDEMPOTENCY_KEY = 50;                              // Lark's limit

export function createLarkPlatform({
  larkCli = process.env.LARK_CLI || 'lark-cli',
  profile = process.env.LARK_PROFILE || '',
  sendTimeoutMs = SEND_TIMEOUT_MS,
  log = console.log,
} = {}) {
  const common = ['--as', 'bot', ...(profile ? ['--profile', profile] : [])];
  const sequences = new Map();                                 // cardId -> last sequence used

  // Run one lark-cli command and parse its JSON output.
  function larkJson(args) {
    return new Promise((resolve, reject) => {
      execFile(larkCli, [...args, ...common], { timeout: sendTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`lark-cli ${args.slice(0, 2).join(' ')} failed: ${err.message} ${String(stderr).slice(0, 500)}`));
          try { resolve(JSON.parse(stdout)); } catch { resolve({ raw: stdout }); }
        });
    });
  }

  // Long-running `event consume <key>` with stdin held open and respawn on exit.
  // onState reports 'listening' | 'down' | 'closed'; onFatal(message) is called once when
  // restarting cannot help (repeated config errors), and no restart follows it.
  function consume(eventKey, onEvent, { onState = () => {}, onFatal = () => {} } = {}) {
    let child = null;
    let closed = false;
    let attempt = 0;
    let configFailures = [];                  // timestamps of recent config failures

    const start = () => {
      if (closed) return;
      child = spawn(larkCli, ['event', 'consume', eventKey, ...common], {
        stdio: ['pipe', 'pipe', 'pipe'],     // stdin is a real pipe that is never ended (see gotcha above)
      });
      const startedAt = Date.now();
      let ready = false;
      let printed = '';                      // everything this start printed, for findErrorReport()
      const keep = (text) => {
        printed += text + '\n';
        if (printed.length > KEEP_OUTPUT_CHARS) printed = printed.slice(-KEEP_OUTPUT_CHARS);
      };
      const markReady = () => { if (!ready) { ready = true; onState('listening'); } };

      const takeLine = (line, isStderr) => {
        keep(line);
        if (isStderr) {
          if (READY_RE.test(line)) markReady();
          log(`[${eventKey}]`, line);
          return;
        }
        let ev;
        try { ev = JSON.parse(line); } catch { return; }       // a piece of a multi-line block
        if (ev && ev.ok === false) return;                     // an error report is not an event
        markReady();                                           // an event is proof of a connection
        try { onEvent(ev); } catch (err) { log(`${eventKey} handler failed:`, err.message); }
      };
      const lines = (stream, isStderr) => {
        let buf = '';
        stream.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) takeLine(line, isStderr);
          }
        });
        stream.on('end', () => { if (buf.trim()) takeLine(buf.trim(), isStderr); });
      };
      lines(child.stdout, false);
      lines(child.stderr, true);

      child.on('error', (err) => log(`${eventKey} consumer error:`, err.message));
      child.on('close', (code) => {
        if (closed) return onState('closed');
        onState('down');

        const lastError = findErrorReport(printed);
        if (lastError) log(`[${eventKey}] lark-cli error:`, JSON.stringify(lastError));
        const isConfig = code === CONFIG_EXIT_CODE || lastError?.type === 'config';
        const now = Date.now();
        configFailures = isConfig ? [...configFailures.filter((t) => now - t < FATAL_WINDOW_MS), now] : [];
        if (configFailures.length >= FATAL_CONFIG_FAILURES) {
          closed = true;
          return onFatal(describeFatal(eventKey, lastError, code));
        }

        // A consumer that lived a while earns a fresh backoff; one that dies at once backs off.
        attempt = now - startedAt > 60_000 ? 0 : attempt + 1;
        const wait = Math.min(RESPAWN_BASE_MS * 2 ** Math.max(attempt - 1, 0), RESPAWN_MAX_MS);
        log(`${eventKey} consumer exited (${code}); restarting in ${wait} ms`);
        // NOT unref'd: while every consumer is down, this timer is the only thing keeping the
        // process alive. An unref'd timer here lets Node exit with code 0 in the gap.
        setTimeout(start, wait);
      });
    };

    start();
    return {
      close() {
        closed = true;
        try { child?.kill('SIGTERM'); } catch {}
      },
    };
  }

  const targetArgs = (target) =>
    target.chatId ? ['--chat-id', target.chatId] : ['--user-id', target.userId];

  const keyArgs = (key) => (key ? ['--idempotency-key', shortKey(key)] : []);

  return {
    consumeMessages(onMessage, { onState, onFatal } = {}) {
      return consume('im.message.receive_v1', (ev) => {
        onMessage({
          eventId: ev.message_id || ev.id || ev.event_id,
          userId: ev.sender_id,
          chatId: ev.chat_id,
          chatType: ev.chat_type,
          messageType: ev.message_type,
          // In groups the text carries placeholders like "@_user_1" for each mention.
          text: String(ev.content || '').replace(/@_user_\d+/g, '').trim(),
          mentions: (ev.mentions || []).map((m) => ({ id: m.id, name: m.name })),
        });
      }, { onState, onFatal });
    },

    async sendMessage(target, text, { idempotencyKey } = {}) {
      // Markdown, not plain text: models write markdown, and as plain text **bold** and
      // backticks arrive as literal symbols.
      // lark-cli's --markdown resolves image URLs found in the text, which means a fetch.
      // The text is model output, so without neutraliseImageLinks() the model could make
      // the bridge request any URL of its choosing.
      const safe = neutraliseImageLinks(text);
      const out = await larkJson(['im', '+messages-send', ...targetArgs(target), '--markdown', safe, ...keyArgs(idempotencyKey)]);
      return { messageId: findKey(out, 'message_id') };
    },

    async sendCard(target, card, { idempotencyKey } = {}) {
      // Two steps: create a card entity, then send a message that points at it.
      const created = await larkJson(['api', 'POST', '/open-apis/cardkit/v1/cards',
        '--data', JSON.stringify({ type: 'card_json', data: JSON.stringify(renderCard(card)) })]);
      const cardId = findKey(created, 'card_id');
      if (!cardId) throw new Error(`card create returned no card_id: ${JSON.stringify(created).slice(0, 300)}`);
      sequences.set(cardId, 0);
      const sent = await larkJson(['im', '+messages-send', ...targetArgs(target), '--msg-type', 'interactive',
        '--content', JSON.stringify({ type: 'card', data: { card_id: cardId } }), ...keyArgs(idempotencyKey)]);
      return { cardId, messageId: findKey(sent, 'message_id') };
    },

    async updateCard(cardId, card) {
      // Whole-card update: simplest way to also remove the Stop button when the job ends.
      // (Updating only a text element is cheaper while streaming, but leaves the button live.)
      const sequence = (sequences.get(cardId) || 0) + 1;
      sequences.set(cardId, sequence);
      await larkJson(['api', 'PUT', `/open-apis/cardkit/v1/cards/${cardId}`,
        '--data', JSON.stringify({ card: { type: 'card_json', data: JSON.stringify(renderCard(card)) }, sequence })]);
    },

    onCardAction(handler, { onState, onFatal } = {}) {
      return consume('card.action.trigger', (ev) => {
        handler({
          eventId: ev.event_id,
          operatorId: ev.operator_id,
          chatId: ev.chat_id,
          messageId: ev.message_id,
          value: parseValue(ev.action_value),
        });
      }, { onState, onFatal });
    },
  };
}

// Find lark-cli's error report in what a consumer printed: the last JSON object with
// "ok": false and an "error". It may be pretty-printed over many lines and may sit after a
// log prefix, so this scans for balanced braces (strings and escapes respected) instead of
// parsing line by line. Returns the error object, or null.
export function findErrorReport(text) {
  if (typeof text !== 'string' || !text.includes('{')) return null;
  let found = null;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    const end = matchingBrace(text, i);
    if (end < 0) continue;
    let obj;
    try { obj = JSON.parse(text.slice(i, end + 1)); } catch { continue; }
    if (obj && obj.ok === false && obj.error && typeof obj.error === 'object') {
      found = obj.error;
      i = end;                                  // skip past this block; later ones win
    }
  }
  return found;
}

function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}

// One line a person can act on: Lark's message, its code, and the CLI's hint.
export function describeFatal(eventKey, error, exitCode) {
  const why = error?.message || `lark-cli exited with code ${exitCode}`;
  const code = error?.code ? ` (code ${error.code})` : '';
  const hint = error?.hint ? ` Hint: ${error.hint}.` : '';
  return `${eventKey}: ${why}${code}.${hint} This is a setting to fix (app, profile, credentials), not something a restart fixes.`
    .replace(/\.\./g, '.');
}

// Card 2.0 JSON from the platform-neutral card in platform.mjs.
// The card body is markdown too, and it carries text derived from model output (progress
// lines name files the model chose). Same neutralising, so no card path can carry an image link.
export function renderCard({ title, markdown, buttons = [] }) {
  const elements = [{ tag: 'markdown', element_id: 'body', content: neutraliseImageLinks(markdown || ' ') }];
  for (const b of buttons) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: b.text },
      type: b.type || 'default',
      behaviors: [{ type: 'callback', value: b.value }],
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    body: { elements },
  };
}

// Turn every image in markdown into plain text, so nothing downstream fetches it.
//
//   ![alt](url "title")        becomes  [image: alt] `url`
//   ![alt][ref] / ![alt][] / ![alt] with a matching `[ref]: url` definition: the same
//   <img src="url" alt="alt">  becomes  [image: alt] `url`
//
// Ordinary links ([text](url)) and reference definitions are left as they are, since normal
// links may use the definitions too. The URL is kept inside inline code, where it can
// neither render as an image nor become a link, so you can still see what the model meant.
// This runs inside code fences as well, on purpose: a renderer that disagrees about where
// a fence ends would otherwise fetch the "code". Safety wins over a verbatim code block.
// A final pass breaks any "![" or "<img" the patterns above did not recognise (for
// example a URL with parentheses in it), so a miss degrades to odd-looking text, never a fetch.
export function neutraliseImageLinks(text) {
  if (typeof text !== 'string' || !text) return text;
  const label = (alt) => `[image: ${String(alt).replace(/[\[\]]/g, '').trim() || 'no description'}]`;
  const code = (url) => ` \`${String(url).replace(/`/g, '')}\``;

  // Reference definitions: [ref]: url "optional title". Labels match case-insensitively.
  const defs = new Map();
  for (const m of text.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm)) {
    defs.set(m[1].trim().toLowerCase(), m[2]);
  }

  let out = text
    // Inline: ![alt](url) or ![alt](<url> "title")
    // (the URL may hold one level of balanced parentheses, as some wiki links do)
    .replace(/!\[([^\]]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
      (_, alt, url) => label(alt) + (url ? code(url) : ''))
    // Reference: ![alt][ref] and collapsed ![alt][]
    .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (_, alt, ref) => {
      const url = defs.get((ref || alt).trim().toLowerCase());
      return label(alt) + (url ? code(url) : '');
    })
    // Shortcut: ![alt] when [alt] is defined
    .replace(/!\[([^\]]+)\](?![(\[])/g, (whole, alt) => {
      const url = defs.get(alt.trim().toLowerCase());
      return url ? label(alt) + code(url) : whole;
    })
    // HTML: <img ... src="url" ... alt="alt" ...>
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const alt = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = src && (src[1] ?? src[2] ?? src[3]);
      return label(alt ? (alt[1] ?? alt[2] ?? alt[3]) : '') + (url ? code(url) : '');
    });

  // Final guard for anything the patterns missed.
  out = out.replace(/!\[/g, '! [').replace(/<img/gi, '&lt;img');
  return out;
}

// The action value may be a JSON string, an object, or garbage. Never throw on it.
export function parseValue(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Lark's idempotency key is at most 50 characters; hash longer keys to a stable 40.
function shortKey(key) {
  return key.length <= MAX_IDEMPOTENCY_KEY ? key : createHash('sha1').update(key).digest('hex');
}

// CLI output shapes vary between commands (some wrap in `data`), so search for the key.
function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (typeof obj[key] === 'string') return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key);
    if (hit) return hit;
  }
  return undefined;
}
