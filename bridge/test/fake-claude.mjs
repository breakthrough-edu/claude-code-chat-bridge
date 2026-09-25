#!/usr/bin/env node
// A stand-in for `claude -p ... --output-format stream-json`, for offline tests.
//
// It reads the same argv the bridge passes, and prints stream-json events shaped like the
// real ones (system/init, assistant tool_use, user tool_result, partial text, result) on a
// compressed clock. You cannot test a watchdog against the real CLI cheaply: it will not
// fake a long wait for you, and it should not. So the behaviour is scripted by env:
//
//   FAKE_CLAUDE_MODE
//     normal            init, a Read, some text, a successful result
//     denied            like normal, but the result carries a permission_denials entry
//     silent-hang       init, then nothing ever again (the watchdog must kill it)
//     tool-open-hang    init, a tool_use whose tool_result never comes (only the hard cap may kill it)
//     cage-extra-tool   init reports one tool more than --tools asked for
//     cage-bypass       init reports permissionMode bypassPermissions
//     dead-resume       with --resume: the "No conversation found" error; without: normal
//     crash-after-write init, a Write tool_use and its result, then exit 1 with no result
//     write-then-hang   init, a Write tool_use and its result, then silence forever
//     draft-outbox      init, a Write that really creates outbox/<name>.json in its cwd (the
//                       way a model proposes an approval card), then a successful result
//
//   FAKE_CLAUDE_TICK_MS   delay between events (default 20)
//   FAKE_CLAUDE_LOG       file to append one JSON line per invocation (argv), so tests can
//                         count how many times the bridge really ran claude
//   FAKE_CLAUDE_PIDFILE   in hang modes, spawn a grandchild in the same process group and
//                         write its pid here, so tests can check a stop killed the group
//   FAKE_CLAUDE_DRAFT     draft-outbox only: the file's text (default: a valid write-outside draft)
//   FAKE_CLAUDE_DRAFT_NAME  draft-outbox only: the file name (default draft.json)
//   FAKE_CLAUDE_DRAFT_CRASH draft-outbox only: exit 1 after writing the draft, with no result
//   FAKE_CLAUDE_ESCAPEE   with PIDFILE: also spawn a grandchild in its OWN session that
//                         inherits stdout, like a tool that daemonised. It survives the
//                         group kill and holds the pipe open; the bridge must force the pipe.

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const mode = process.env.FAKE_CLAUDE_MODE || 'normal';
const tick = Number(process.env.FAKE_CLAUDE_TICK_MS || 20);
const prompt = flag('-p') || '';
const resume = flag('--resume');
const tools = (flag('--tools') || '').split(',').filter(Boolean);
const permissionMode = flag('--permission-mode') || 'default';
const model = flag('--model') || 'fake-model';
const sessionId = resume || randomUUID();
const cwd = process.cwd();

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, mode, argv }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const uuid = () => randomUUID();
const toolId = () => `toolu_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5, service_tier: 'standard' };

function assistant(content) {
  return {
    type: 'assistant',
    message: {
      id: `msg_fake_${randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model,
      content, stop_reason: null, stop_sequence: null, usage,
    },
    parent_tool_use_id: null, session_id: sessionId, uuid: uuid(),
  };
}

function toolResult(id, text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text }] },
    parent_tool_use_id: null, session_id: sessionId, uuid: uuid(),
  };
}

function partial(text) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    session_id: sessionId, parent_tool_use_id: null, uuid: uuid(),
  };
}

function result({ isError = false, text = '', turns = 2, denials = [], subtype = 'success' } = {}) {
  return {
    type: 'result', subtype, is_error: isError, duration_ms: tick * 6, duration_api_ms: tick * 4,
    num_turns: turns, result: text, stop_reason: isError ? null : 'end_turn', session_id: sessionId,
    total_cost_usd: 0, usage, modelUsage: {}, permission_denials: denials, uuid: uuid(),
  };
}

function init() {
  let reportedTools = [...tools];
  let reportedMode = permissionMode;
  if (mode === 'cage-extra-tool') reportedTools = [...tools, 'Bash'];
  if (mode === 'cage-bypass') reportedMode = 'bypassPermissions';
  // With hooks installed, hook events come BEFORE init. Emit one so the bridge has to
  // find init by type, not by position.
  emit({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart', session_id: sessionId, uuid: uuid() });
  emit({
    type: 'system', subtype: 'init', cwd, session_id: sessionId, tools: reportedTools, mcp_servers: [],
    model, permissionMode: reportedMode, slash_commands: [], apiKeySource: 'none',
    claude_code_version: 'fake', output_style: 'default', agents: [], skills: [], plugins: [], uuid: uuid(),
  });
}

function spawnGrandchildren() {
  const pidfile = process.env.FAKE_CLAUDE_PIDFILE;
  if (!pidfile) return;
  const keepAlive = ['-e', 'setInterval(() => {}, 1000)'];
  // Same process group: dies with a group kill.
  const inGroup = spawn(process.execPath, keepAlive, { stdio: 'ignore' });
  const pids = { inGroup: inGroup.pid };
  if (process.env.FAKE_CLAUDE_ESCAPEE) {
    // Own session, stdout inherited: survives the group kill and keeps the pipe open.
    const escapee = spawn(process.execPath, keepAlive, { stdio: ['ignore', 'inherit', 'ignore'], detached: true });
    escapee.unref();
    pids.escapee = escapee.pid;
  }
  writeFileSync(pidfile, JSON.stringify(pids));
}

const hangForever = () => setInterval(() => {}, 1 << 30);

async function main() {
  if (mode === 'dead-resume' && resume) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    emit(result({ isError: true, turns: 0, subtype: 'error_during_execution' }));
    process.exitCode = 1;                    // let stdout drain; process.exit() can cut a pipe write short
    return;
  }

  init();
  await sleep(tick);

  if (mode === 'silent-hang') { spawnGrandchildren(); return hangForever(); }

  if (mode === 'tool-open-hang') {
    spawnGrandchildren();
    emit(assistant([{ type: 'tool_use', id: toolId(), name: 'Grep', input: { pattern: 'x' } }]));
    return hangForever();
  }

  if (mode === 'crash-after-write' || mode === 'write-then-hang') {
    const id = toolId();
    emit(assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: `${cwd}/half-done.md`, content: 'part one' } }]));
    await sleep(tick);
    emit(toolResult(id, 'File created successfully'));
    await sleep(tick);
    if (mode === 'crash-after-write') process.exit(1);
    spawnGrandchildren();
    return hangForever();
  }

  if (mode === 'draft-outbox') {
    const name = process.env.FAKE_CLAUDE_DRAFT_NAME || 'draft.json';
    const text = process.env.FAKE_CLAUDE_DRAFT
      || JSON.stringify({ action: 'write-outside', title: 'Notes for Friday', content: '# Notes\n\n- first item\n' }, null, 2) + '\n';
    const id = toolId();
    emit(assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: `${cwd}/outbox/${name}`, content: text } }]));
    mkdirSync(`${cwd}/outbox`, { recursive: true });
    writeFileSync(`${cwd}/outbox/${name}`, text);
    await sleep(tick);
    emit(toolResult(id, 'File created successfully'));
    await sleep(tick);
    if (process.env.FAKE_CLAUDE_DRAFT_CRASH) process.exit(1);   // the draft is there, the run is not done
    emit(result({ text: 'I drafted it; approve the card to write it.' }));
    return;
  }

  // normal, denied, cage-* (the bridge should have stopped cage-* runs by now), dead-resume fresh
  const id = toolId();
  emit(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `${cwd}/notes.md` } }]));
  await sleep(tick);
  emit(toolResult(id, '1\tsome notes'));
  await sleep(tick);
  const reply = `ok: ${prompt.slice(0, 60)}`;
  emit(partial(reply.slice(0, 4)));
  await sleep(tick);
  emit(partial(reply.slice(4)));
  emit(assistant([{ type: 'text', text: reply }]));
  await sleep(tick);
  const denials = mode === 'denied'
    ? [{ tool_name: 'Write', tool_use_id: toolId(), tool_input: { file_path: '/etc/hosts', content: 'x' } }]
    : [];
  emit(result({ text: reply, denials }));
}

main();
