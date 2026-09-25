#!/usr/bin/env node
// Replay your own Claude Code transcripts through the watchdog's logic before you trust its
// numbers. Test the watchdog against what your agent actually does, not against fixtures.
//
// Usage:
//   node scripts/replay-transcripts.mjs                 # every ~/.claude/projects/*/*.jsonl
//   node scripts/replay-transcripts.mjs <dir|file> ...  # only these
//
// It prints, never content, only timings and file names:
//   - the longest gaps with NO tool open that ended in model output. That is what the
//     silence watchdog (IDLE_MS) sees, so IDLE_MS must sit comfortably above it;
//   - the longest single tool call. The watchdog is paused during a tool, so only the hard
//     cap (HARD_CAP_MS) bounds it.
//
// Read both numbers as upper bounds. Transcripts store a finished message, not the partial
// text a live `--include-partial-messages` run streams, so a long answer shows up here as
// one long silence that a live run would not have. And in an interactive session a tool
// call includes any time a permission prompt waited for you, which a headless run never
// does. Look at the top entries before you set a limit from them.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { makeToolTracker } from '../bridge/idle-watch.mjs';

function listFiles(args) {
  const roots = args.length ? args : [join(homedir(), '.claude', 'projects')];
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) { console.error(`not found: ${root}`); continue; }
    if (statSync(root).isFile()) { files.push(root); continue; }
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      if (name.endsWith('.jsonl') && statSync(p).isFile()) files.push(p);
      else if (statSync(p).isDirectory()) {
        for (const inner of readdirSync(p)) if (inner.endsWith('.jsonl')) files.push(join(p, inner));
      }
    }
  }
  return files;
}

// A human prompt starts a new turn. Its content is a plain string, or an array (text,
// images, attachments) with no tool results in it.
const isHumanPrompt = (ev) => {
  if (ev.type !== 'user') return false;
  const c = ev.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => b?.type === 'tool_result');
};

// Tools that wait for a person by design. A headless bridge never loads them, and in an
// interactive transcript they measure your reaction time, not the agent.
const WAITS_FOR_A_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode']);

function replay(file) {
  const gaps = [];
  const tools = [];
  let tracker = makeToolTracker();
  const toolStart = new Map();
  const seenUuids = new Set();
  let prev = null;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.isSidechain) continue;                           // sub-agent traffic interleaved in older files
    const t = Date.parse(ev.timestamp);
    if (!Number.isFinite(t)) continue;

    // A resumed or rewound session can append copies of earlier rows to the same file.
    // Skip rows already seen, and treat a jump back in time as the start of a new segment,
    // or the replay reports hours between two rows that were never next to each other.
    if (ev.uuid) {
      if (seenUuids.has(ev.uuid)) continue;
      seenUuids.add(ev.uuid);
    }
    if (prev && t < prev.t) {
      tracker = makeToolTracker();
      toolStart.clear();
      prev = null;
    }

    // Other timestamped rows (hook output, queued messages, background task notices) are
    // activity: the live watchdog re-arms on every event too. They move the clock, nothing else.
    if (ev.type !== 'user' && ev.type !== 'assistant') {
      prev = { t };
      continue;
    }

    if (isHumanPrompt(ev)) {
      // Time before a human prompt is thinking time, not model silence. Start clean;
      // this also clears tool calls left open by an interrupted turn.
      tracker = makeToolTracker();
      toolStart.clear();
      prev = { t };
      continue;
    }

    // Only gaps that end in model output and had no tool open count as "silence".
    if (prev && ev.type === 'assistant' && tracker.openCount === 0) {
      gaps.push({ ms: t - prev.t, file, at: ev.timestamp });
    }

    for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
      if (ev.type === 'assistant' && b?.type === 'tool_use') toolStart.set(b.id, { t, name: b.name });
      if (ev.type === 'user' && b?.type === 'tool_result' && toolStart.has(b.tool_use_id)) {
        const s = toolStart.get(b.tool_use_id);
        if (!WAITS_FOR_A_PERSON.has(s.name)) tools.push({ ms: t - s.t, name: s.name, file, at: ev.timestamp });
        toolStart.delete(b.tool_use_id);
      }
    }
    tracker.feed(ev);
    prev = { t };
  }
  return { gaps, tools };
}

const fmt = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const where = (r) => `${basename(join(r.file, '..'))}/${basename(r.file)} at ${r.at}`;

const files = listFiles(process.argv.slice(2));
if (!files.length) { console.error('no .jsonl transcripts found'); process.exit(1); }

const allGaps = [];
const allTools = [];
for (const f of files) {
  try {
    const { gaps, tools } = replay(f);
    allGaps.push(...gaps);
    allTools.push(...tools);
  } catch (err) {
    console.error(`skipped ${basename(f)}: ${err.message}`);
  }
}
allGaps.sort((a, b) => b.ms - a.ms);
allTools.sort((a, b) => b.ms - a.ms);

console.log(`transcripts: ${files.length}, silence gaps measured: ${allGaps.length}, tool calls matched: ${allTools.length}`);
console.log('\nLongest gaps with no tool open (what IDLE_MS must exceed):');
for (const g of allGaps.slice(0, 5)) console.log(`  ${fmt(g.ms).padStart(9)}  ${where(g)}`);
console.log('\nLongest tool calls (only HARD_CAP_MS bounds these):');
for (const t of allTools.slice(0, 5)) console.log(`  ${fmt(t.ms).padStart(9)}  ${t.name.padEnd(10)} ${where(t)}`);
if (allGaps.length) console.log(`\nLongest no-tool-open gap: ${fmt(allGaps[0].ms)}`);
