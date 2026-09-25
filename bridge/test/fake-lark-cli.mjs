#!/usr/bin/env node
// A stand-in for lark-cli, so platform-lark.mjs can be tested without any Lark app.
// It appends its argv to FAKE_LARK_LOG and answers the few commands the platform uses.
//
//   event consume <key> ...   prints one event for that key, then behaves like the real
//                             command: it keeps running until its stdin reaches EOF.
//   api POST .../cards        prints a card_id
//   api PUT .../cards/<id>    prints ok
//   im +messages-send ...     prints a message_id
//
// FAKE_LARK_MODE changes how `event consume` behaves:
//   (unset)            as above
//   quiet              connects and prints no event
//   not-ready          stays running but never prints the ready line (never connected)
//   config-error       prints the error a disabled app gets and exits 3, every time
//   config-error-once  the first start per event key fails like config-error, later ones connect
//   transient          exits 1 at once with no error report, every time
//   whoami             prints the ready line, then one direct message event, then waits
// FAKE_LARK_SIGNALS    a file; a SIGTERM received by `event consume` is appended to it
// FAKE_LARK_COUNTER is a folder for per-key start counts (needed by config-error-once).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_LARK_LOG) appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(argv) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const mode = process.env.FAKE_LARK_MODE || '';

function startsFor(key) {
  const dir = process.env.FAKE_LARK_COUNTER;
  if (!dir) return 1;
  const f = join(dir, `${key}.count`);
  const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1;
  writeFileSync(f, String(n));
  return n;
}

// What lark-cli prints for an app that is switched off in the developer console:
// pretty-printed JSON over many lines, then exit code 3.
const DISABLED_APP = {
  ok: false,
  identity: 'bot',
  error: {
    type: 'config',
    subtype: 'invalid_client',
    code: 20069,
    message: 'The specified app is not enabled.',
    hint: 'run `lark-cli config init` to set valid app_id and app_secret',
  },
  _notice: { text: 'a notice with {braces} in a string' },
};

if (argv[0] === 'event' && argv[1] === 'consume') {
  if (process.env.FAKE_LARK_SIGNALS) {
    process.on('SIGTERM', () => { appendFileSync(process.env.FAKE_LARK_SIGNALS, 'SIGTERM\n'); process.exit(0); });
  }
  const n = startsFor(argv[2]);
  if (mode === 'config-error' || (mode === 'config-error-once' && n === 1)) {
    process.stderr.write(JSON.stringify(DISABLED_APP, null, 2) + '\n');
    process.exitCode = 3;
  } else if (mode === 'transient') {
    process.exitCode = 1;
  } else {
    // The real CLI announces a live connection on stderr. Only then is it listening.
    if (mode !== 'not-ready') process.stderr.write(`[event] ready event_key=${argv[2]}\n`);
    if (mode === 'whoami') {
      // The one-line shape lark-cli prints for a direct message.
      out({ type: 'im.message.receive_v1', event_id: 'ev_test_2', message_id: 'om_test_2', chat_id: 'oc_test_dm',
        chat_type: 'p2p', message_type: 'text', sender_id: 'ou_test_owner', sender_type: 'user', content: 'hi' });
    } else if (mode !== 'quiet' && mode !== 'not-ready' && mode !== 'config-error-once') {
      emitEvent(argv[2]);
    }
    // Like the real command: stdin EOF means stop.
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
  }
} else if (argv[0] === 'api' && argv[1] === 'POST') {
  out({ code: 0, data: { card_id: 'card_test_1' } });
} else if (argv[0] === 'api' && argv[1] === 'PUT') {
  out({ code: 0, data: {} });
} else if (argv[0] === 'im' && argv[1] === '+messages-send') {
  out({ ok: true, data: { message_id: 'om_test_sent' } });
} else {
  process.stderr.write(`fake lark-cli: unhandled ${argv.join(' ')}\n`);
  process.exit(2);
}

function emitEvent(key) {
  if (key === 'im.message.receive_v1') {
    out({
      type: 'im.message.receive_v1', event_id: 'ev_test_1', message_id: 'om_test_1',
      sender_id: 'ou_test_owner', chat_id: 'oc_test_group', chat_type: 'group', message_type: 'text',
      content: '@_user_1 summarise my notes', mentions: [{ id: 'ou_test_bot', key: '@_user_1', name: 'bot' }],
    });
  } else if (key === 'card.action.trigger') {
    out({ event_id: 'ev_test_tap', operator_id: 'ou_test_owner', chat_id: 'oc_test_dm', message_id: 'om_test_card',
      action_value: '{"kind":"stop","job":"job-1"}' });
  }
}
