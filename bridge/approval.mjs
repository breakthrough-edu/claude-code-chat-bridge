// The approval card (docs/approval-card.md): one card, one action, the exact content pinned,
// and on the tap the PROGRAM executes that pinned content. The model is never asked again.
//
// How a draft gets here. The model cannot run the action: it has no tool that reaches
// outside the working directory. What it can do is write a draft file into
// `<WORKDIR>/outbox/`. After the run, the bridge (this file, not the model):
//   1. reads each draft file, refusing symlinks, folders and oversized files;
//   2. parses it strictly (a code fence around the JSON and a trailing newline are fine;
//      anything else wrong is refused with a message that says what);
//   3. moves the raw file out of the outbox into the state folder, as evidence;
//   4. pins the draft: a draft id made here, the target computed here, a sha256 fingerprint
//      of everything the card shows, an expiry;
//   5. sends ONE card for it, showing all of that, with Approve and Reject buttons whose
//      value carries the draft id and the fingerprint.
//
// On a tap (handleAction):
//   - the tapper already passed the sender allowlist and the tap id was deduped (loop.mjs);
//   - unknown draft, fingerprint mismatch or expiry: refused, nothing runs;
//   - the claim is single-use: pending -> claimed happens synchronously and is written to
//     disk before anything else, so a second tap finds it claimed and does nothing;
//   - the action module runs the pinned draft: check before, write, read back;
//   - success is recorded only after the read-back, then the card is repainted as spent,
//     with no buttons;
//   - every failure puts the draft back to pending and repaints the card WITH its buttons,
//     so a failed attempt never leaves a dead card (after MAX_ATTEMPTS it stops as failed).
//
// Draft states: pending -> claimed -> done | pending (failure) | failed (too many failures);
//               pending -> rejected | expired.
//
// One process owns the store. The claim is atomic inside this process (Node runs one
// handler at a time and the claim has no await in it). Two bridges on the same app and the
// same state folder would each hold their own copy; do not run two (docs/gotchas.md).

import {
  readdirSync, lstatSync, readFileSync, renameSync, copyFileSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic } from './state-file.mjs';

export const OUTBOX_DIRNAME = 'outbox';

// Every limit has a name (Limits cell).
export const APPROVAL_LIMITS = {
  TTL_MS: 24 * 60 * 60_000,         // a card not tapped within a day expires; what it shows ages
  MAX_ATTEMPTS: 3,                  // failed executions before the draft stops as failed
  MAX_DRAFTS_PER_RUN: 3,            // outbox files carded after one run; the rest are refused
  MAX_DRAFT_FILE_BYTES: 64 * 1024,  // a draft file bigger than this is refused unread
  MAX_KEPT: 200,                    // finished drafts kept in the store, oldest dropped first
  SEND_TIMEOUT_MS: 60_000,          // one card send or repaint
  SEND_RETRIES: 2,                  // retries after a failed send or repaint
  RETRY_BACKOFF_MS: 2000,           // doubled after every failed attempt
};

export const DRAFT_STATES = ['pending', 'claimed', 'done', 'rejected', 'expired', 'failed'];
const FINAL = new Set(['done', 'rejected', 'expired', 'failed']);
const ENVELOPE_KEYS = ['action'];

// ---------------------------------------------------------------------------------------
// Parsing what the model wrote. Pure, so it can be fed real model output in a test.
// Accepted: surrounding whitespace, a trailing newline, a UTF-8 byte order mark, CRLF line
// ends, and ONE code fence (``` or ```json) around the whole thing. Refused: everything
// else, each with a message that says what to fix.
// ---------------------------------------------------------------------------------------
export function parseDraftText(raw, actions) {
  let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!text) return fail('the draft file is empty');

  const fence = text.match(/^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_-]*)[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/);
  if (fence) {
    const lang = fence[2].toLowerCase();
    if (lang && lang !== 'json') return fail(`the code fence says "${fence[2]}"; it must be json or nothing`);
    text = fence[3].trim();
  } else if (/^(`{3,}|~{3,})/.test(text) || /\n(`{3,}|~{3,})/.test(text)) {
    return fail('found text outside the code fence, or a fence that does not close; the file must hold only the JSON (a code fence around it is fine)');
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return fail(`not valid JSON (${err.message}); write one JSON object and nothing else`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return fail('the JSON must be one object like {"action": "...", ...}, not a list or a single value');
  }

  const known = Object.keys(actions || {});
  if (typeof obj.action !== 'string' || !actions[obj.action]) {
    return fail(`"action" must be one of: ${known.join(', ') || '(no actions configured)'}; got ${JSON.stringify(obj.action)}`);
  }
  const action = actions[obj.action];
  const allowed = [...ENVELOPE_KEYS, ...action.fields];
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) {
    return fail(`unknown key${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')}; "${obj.action}" takes only ${allowed.map((k) => `"${k}"`).join(', ')}`);
  }
  const fields = {};
  for (const k of action.fields) fields[k] = obj[k];
  const checked = validateFields(action, fields);
  if (!checked.ok) return checked;
  return { ok: true, value: { action: obj.action, ...checked.value } };
}

// Card-faithfulness: the card must show every drafted value exactly as it will be written.
// The platform layer rewrites image syntax in every card body before sending it
// (neutraliseImageLinks in platform-lark.mjs, so a card can never make the client fetch a
// URL), and that rewrite applies inside code blocks too. A value holding image syntax would
// be written one way and shown another, so it is refused here, for every action's fields.
const IMAGE_SYNTAX = /!\[|<img/i;

export function cardSafe(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && IMAGE_SYNTAX.test(value)) {
      return fail(`"${key}" contains image syntax ("![" or "<img"), which is not allowed in a carded draft, because the card could not show it faithfully; describe the image or give the plain URL`);
    }
  }
  return { ok: true };
}

// Schema check plus card-faithfulness check: the one place a draft's fields are validated,
// used both when parsing a draft file and when propose() is called directly.
function validateFields(action, fields) {
  const checked = action.validate(fields);
  if (!checked.ok) return checked;
  const safe = cardSafe(checked.value);
  return safe.ok ? checked : safe;
}

// The fingerprint covers everything the card shows and the program executes. Built with a
// fixed key order so the same draft always hashes the same.
export function fingerprint({ action, target, title, content }) {
  const canonical = JSON.stringify({ v: 1, action, target, title, content });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------
// The card. Pure: the same draft in the same state always renders the same card.
// ---------------------------------------------------------------------------------------
export function renderApprovalCard(d) {
  const fence = '`'.repeat(Math.max(3, longestRun(d.content, '`') + 1));
  const body = [
    `**Action:** ${d.describe}`,
    `**Target:** \`${d.target}\``,
    `**What it is:** ${d.title}`,
    `**Current:** ${d.current}`,
    `**New content** (exactly what will be written, ${d.content.length} characters):`,
    `${fence}\n${d.content}\n${fence}`,
    `Draft \`${d.id}\` · fingerprint \`${d.fingerprint.slice(0, 12)}\` · expires ${utc(d.expiresAt)}`,
  ];
  const approve = { text: 'Approve', type: 'primary', value: { kind: 'approve', draft: d.id, fp: d.fingerprint } };
  const reject = { text: 'Reject', type: 'default', value: { kind: 'reject', draft: d.id, fp: d.fingerprint } };

  switch (d.state) {
    case 'pending': {
      const head = d.lastError
        ? `**Not yet written.** The last attempt did not finish: ${d.lastError}\nTap Approve to try again (attempt ${d.attempts + 1} of ${d.maxAttempts}), or Reject.`
        : '**Not yet written.** Nothing happens until you tap Approve.';
      return { title: `Approve? ${d.describe}`, markdown: [head, ...body].join('\n\n'), buttons: [approve, reject] };
    }
    case 'claimed':
      return { title: `Writing: ${d.describe}`, markdown: ['**Writing now.**', ...body].join('\n\n'), buttons: [] };
    case 'done': {
      const how = d.result?.status === 'already-done'
        ? 'It was already there with exactly this content, so it was not written again.'
        : 'Written, then read back and checked against the fingerprint.';
      return { title: 'Done', markdown: [`**Done** ${utc(d.doneAt)}. ${how}`, ...body].join('\n\n'), buttons: [] };
    }
    case 'rejected':
      return { title: 'Rejected', markdown: [`**Rejected** ${utc(d.rejectedAt)}. Nothing was written.`, ...body].join('\n\n'), buttons: [] };
    case 'expired':
      return { title: 'Expired', markdown: ['**Expired before it was approved.** Nothing was written. Ask again if you still want it.', ...body].join('\n\n'), buttons: [] };
    case 'failed':
      return {
        title: 'Failed',
        markdown: [`**Failed ${d.attempts} times; stopped trying.** Last error: ${d.lastError}\nCheck the target by hand before asking again.`, ...body].join('\n\n'),
        buttons: [],
      };
    default:
      throw new Error(`unknown draft state ${d.state}`);
  }
}

// ---------------------------------------------------------------------------------------
// The store and the runtime.
// ---------------------------------------------------------------------------------------
export function createApproval({
  platform,
  stateDir,
  workdir,
  actions,                                        // { [name]: action module }
  outboxDir = workdir ? join(workdir, OUTBOX_DIRNAME) : null,
  limits = {},
  now = () => Date.now(),
  log = (...a) => console.log(new Date().toISOString(), ...a),
}) {
  if (!platform || !stateDir || !actions) throw new Error('approval: platform, stateDir and actions are required');
  const L = { ...APPROVAL_LIMITS, ...limits };
  const file = join(stateDir, 'approvals.json');
  const rawDir = join(stateDir, 'approvals', 'raw');
  const rejectedDir = join(stateDir, 'approvals', 'rejected');
  const state = readJson(file, null) || { drafts: [] };
  const inflight = new Set();

  const save = () => {
    const isFinal = (d) => FINAL.has(d.state);
    while (state.drafts.length > L.MAX_KEPT) {
      const i = state.drafts.findIndex(isFinal);
      if (i < 0) break;                           // never drop an open draft
      state.drafts.splice(i, 1);
    }
    writeJsonAtomic(file, state);
  };
  const find = (id) => state.drafts.find((d) => d.id === id);
  const iso = (ms = now()) => new Date(ms).toISOString();

  const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p; };

  async function retrying(label, fn) {
    let lastErr;
    for (let attempt = 0; attempt <= L.SEND_RETRIES; attempt++) {
      try {
        return await withTimeout(fn(), L.SEND_TIMEOUT_MS, label);
      } catch (err) {
        lastErr = err;
        log(`approval: ${label} failed (attempt ${attempt + 1}):`, err.message);
        if (attempt < L.SEND_RETRIES) await sleep(L.RETRY_BACKOFF_MS * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  // Repaint never throws: a card that fails to repaint keeps its old buttons, and the next
  // tap on it repaints it again from the stored state.
  async function paint(d) {
    if (!d.cardId) return false;
    try {
      await retrying(`repaint ${d.id}`, () => platform.updateCard(d.cardId, renderApprovalCard(view(d))));
      return true;
    } catch {
      return false;
    }
  }

  async function tell(chatId, key, text) {
    if (!chatId) return;
    try {
      await retrying(key, () => platform.sendMessage({ chatId }, text, { idempotencyKey: key }));
    } catch {}
  }

  function view(d) {
    return { ...d, describe: actions[d.action]?.describe || d.action, maxAttempts: L.MAX_ATTEMPTS };
  }

  // Pin a validated draft and send its card. `input` is { action, title, content }.
  async function propose(input, { chatId, jobId = null, raw = null } = {}) {
    const action = actions[input?.action];
    if (!action) return { ok: false, error: `unknown action ${JSON.stringify(input?.action)}` };
    const fields = {};
    for (const k of action.fields) fields[k] = input[k];
    const checked = validateFields(action, fields);     // validated again: callers cannot skip it
    if (!checked.ok) return checked;
    const { title, content } = checked.value;

    const id = `draft-${now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const target = action.target(id);
    const fp = fingerprint({ action: action.name, target, title, content });
    const d = {
      id, action: action.name, target, title, content, fingerprint: fp,
      current: action.current(target).text,
      chatId, jobId, raw, cardId: null,
      state: 'pending', attempts: 0, lastError: null,
      createdAt: iso(), expiresAt: iso(now() + L.TTL_MS),
    };
    state.drafts.push(d);
    save();                                           // pinned on disk before the card exists

    try {
      const sent = await retrying(`card ${id}`, () =>
        platform.sendCard({ chatId }, renderApprovalCard(view(d)), { idempotencyKey: `${id}:card` }));
      d.cardId = sent?.cardId || null;
      if (!d.cardId) throw new Error('the platform returned no card id');
      save();
    } catch (err) {
      // No card means nobody can approve it: close it rather than leave an orphan pending.
      Object.assign(d, { state: 'failed', lastError: `card not sent: ${err.message}`, failedAt: iso() });
      save();
      await tell(chatId, `${id}:nocard`, `I drafted "${title}" for approval but could not send the card, so nothing will be written. Ask again.`);
      return { ok: false, error: d.lastError, draftId: id };
    }
    log(`approval: proposed ${id} (${action.name} -> ${target})`);
    return { ok: true, draftId: id };
  }

  // After a run: card every draft file the model left in the outbox, refuse the rest.
  // runOk=false (the run failed or was stopped) refuses all of them: a draft from a run
  // that did not finish is not something to put in front of a person.
  async function collectOutbox({ chatId, jobId = null, runOk = true } = {}) {
    const out = { proposed: [], rejected: [] };
    if (!outboxDir) return out;
    let names;
    try { names = readdirSync(outboxDir).sort(); } catch (err) {
      if (err.code === 'ENOENT') return out;
      throw err;
    }
    names = names.filter((n) => !n.startsWith('.'));

    let carded = 0;
    for (const name of names) {
      const path = join(outboxDir, name);
      const refuse = async (why) => {
        const kept = moveOut(path, rejectedDir, `${iso().replace(/[:.]/g, '-')}-${basename(name)}`);
        out.rejected.push({ file: name, error: why });
        log(`approval: refused outbox/${name}: ${why}${kept ? ` (kept at ${kept})` : ''}`);
        await tell(chatId, `${jobId || 'outbox'}:refused:${name}`.slice(0, 200),
          `I did not card the draft outbox/${name}: ${why}. Nothing was written.`);
      };

      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (!st.isFile()) { await refuse('it is not a plain file (a folder or a link); only plain .json files are read'); continue; }
      if (!name.endsWith('.json')) { await refuse('only .json files are read from the outbox'); continue; }
      if (!runOk) { await refuse('the run did not finish, so its draft is not shown for approval'); continue; }
      if (st.size > L.MAX_DRAFT_FILE_BYTES) { await refuse(`it is ${st.size} bytes; the limit is ${L.MAX_DRAFT_FILE_BYTES}`); continue; }
      if (carded >= L.MAX_DRAFTS_PER_RUN) { await refuse(`one run may propose at most ${L.MAX_DRAFTS_PER_RUN} drafts`); continue; }

      const parsed = parseDraftText(readFileSync(path), actions);
      if (!parsed.ok) { await refuse(parsed.error); continue; }

      // Same content already waiting on a card: do not send a second card for it.
      const dupe = state.drafts.find((d) => ['pending', 'claimed'].includes(d.state) && d.action === parsed.value.action
        && d.title === parsed.value.title && d.content === parsed.value.content);
      if (dupe) { await refuse(`the same draft is already waiting for approval (${dupe.id})`); continue; }

      const res = await propose(parsed.value, { chatId, jobId, raw: name });
      moveOut(path, rawDir, `${res.draftId || iso().replace(/[:.]/g, '-')}-${basename(name)}`);
      if (res.ok) { carded++; out.proposed.push(res.draftId); } else { out.rejected.push({ file: name, error: res.error }); }
    }
    return out;
  }

  // A tap. Takes the CardAction from loop.mjs (or just its value). Never rejects: loop.mjs
  // calls this from a callback where an unhandled rejection would crash the bridge.
  function handleAction(actionOrValue) {
    return track((async () => {
      try {
        return await handle(actionOrValue);
      } catch (err) {
        log('approval: tap handler failed:', err.stack || err.message);
        return { status: 'error', error: err.message };
      }
    })());
  }

  async function handle(actionOrValue) {
    const value = actionOrValue?.value && typeof actionOrValue.value === 'object' ? actionOrValue.value : actionOrValue || {};
    const tapId = actionOrValue?.eventId || 'tap';
    if (value.kind !== 'approve' && value.kind !== 'reject') {
      log('approval: ignored a tap that is not approve or reject');
      return { status: 'ignored' };
    }
    const d = typeof value.draft === 'string' ? find(value.draft) : null;
    if (!d) {
      log(`approval: tap for unknown draft ${String(value.draft).slice(0, 60)}`);
      return { status: 'unknown-draft' };
    }

    // Everything from here to the claim is synchronous: no second tap can slip in between.
    if (value.fp !== d.fingerprint) {
      log(`approval: fingerprint mismatch on ${d.id}; nothing runs`);
      await tell(d.chatId, `${d.id}:fp:${tapId}`.slice(0, 200),
        `A tap on draft ${d.id} did not match its pinned content, so nothing was written. Use the buttons on the card itself.`);
      return { status: 'fingerprint-mismatch' };
    }
    if (d.state !== 'pending') {
      log(`approval: ${d.id} is ${d.state}; tap ignored`);
      if (FINAL.has(d.state)) await paint(d);        // an old live-looking card gets fixed
      return { status: `already-${d.state}` };
    }
    if (now() > Date.parse(d.expiresAt)) {
      Object.assign(d, { state: 'expired', expiredAt: iso() });
      save();
      await paint(d);
      return { status: 'expired' };
    }
    if (value.kind === 'reject') {
      Object.assign(d, { state: 'rejected', rejectedAt: iso() });
      save();
      await paint(d);
      log(`approval: ${d.id} rejected`);
      return { status: 'rejected' };
    }

    // The claim: single use, on disk before the action starts.
    Object.assign(d, { state: 'claimed', claimedAt: iso(), attempts: d.attempts + 1 });
    save();

    let result;
    try {
      const action = actions[d.action];
      if (!action) throw new Error(`action ${d.action} is not configured on this bridge`);
      // The stored draft must still match its own fingerprint: the program runs what the
      // card showed, not whatever the store says now.
      if (fingerprint(d) !== d.fingerprint) throw new Error('the stored draft no longer matches its fingerprint');
      result = await action.execute({ id: d.id, target: d.target, content: d.content });
      if (!result || !['written', 'already-done'].includes(result.status)) {
        throw new Error('the action did not confirm a verified write');
      }
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);
      if (d.attempts >= L.MAX_ATTEMPTS) {
        Object.assign(d, { state: 'failed', lastError: message, failedAt: iso() });
      } else {
        Object.assign(d, { state: 'pending', lastError: message });     // back, so the card lives
      }
      save();
      await paint(d);
      log(`approval: ${d.id} attempt ${d.attempts} failed: ${message}`);
      return { status: d.state === 'failed' ? 'failed' : 'returned-to-pending', error: message };
    }

    Object.assign(d, { state: 'done', doneAt: iso(), result, lastError: null });
    save();
    await paint(d);
    log(`approval: ${d.id} ${result.status} (${result.path})`);
    return { status: 'done', result };
  }

  // At startup, before taps are handled: a draft left `claimed` means the bridge died
  // mid-action. It goes back to pending (the action checks before it writes, so a second
  // tap on something already written is recognised, not repeated). Overdue drafts expire.
  async function recover() {
    const touched = [];
    for (const d of state.drafts) {
      if (d.state === 'claimed') {
        Object.assign(d, {
          state: 'pending',
          lastError: 'the bridge restarted while this was running. If it was already written, approving again is recognised and not repeated',
        });
        touched.push(d);
      } else if (d.state === 'pending' && now() > Date.parse(d.expiresAt)) {
        Object.assign(d, { state: 'expired', expiredAt: iso() });
        touched.push(d);
      }
    }
    if (touched.length) {
      save();
      for (const d of touched) await paint(d);
    }
    return touched.map((d) => ({ id: d.id, state: d.state }));
  }

  return {
    propose,
    collectOutbox,
    handleAction,
    recover,
    // Resolves when every tap being handled has finished. For tests and shutdown.
    settled: () => Promise.allSettled([...inflight]),
    get: (id) => { const d = find(id); return d ? structuredClone(d) : undefined; },
    drafts: () => structuredClone(state.drafts),
    file,
  };
}

// Move a file out of the model's folder into the bridge's state folder (evidence of what
// the model wrote). Returns where it went, or null.
function moveOut(path, dir, name) {
  try {
    mkdirSync(dir, { recursive: true });
    const to = join(dir, name);
    try {
      renameSync(path, to);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      copyFileSync(path, to);
      unlinkSync(path);
    }
    return to;
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }
}

function longestRun(s, ch) {
  let best = 0; let run = 0;
  for (const c of s) { run = c === ch ? run + 1 : 0; if (run > best) best = run; }
  return best;
}

function utc(isoString) {
  return isoString ? `${isoString.slice(0, 16).replace('T', ' ')} UTC` : '';
}

function fail(error) { return { ok: false, error }; }

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
