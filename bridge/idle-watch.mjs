// Tell "slow" from "stuck" (docs/runs.md).
//
// A fixed timeout kills a genuinely long job at the deadline and leaves a hung one
// waiting the full time. So instead:
//   - re-arm a silence timer on every stream event;
//   - pause it while a tool call is open (a tool_use seen, its tool_result not yet),
//     because a long tool is work, not silence;
//   - keep a separate hard cap (in run-claude.mjs) for the one case this cannot see:
//     a tool that never returns.

// Tracks which tool calls are open. Shared with scripts/replay-transcripts.mjs so the
// replay measures exactly what the live watchdog measures.
export function makeToolTracker() {
  const open = new Set();
  return {
    feed(ev) {
      const content = ev?.message?.content;
      if (!Array.isArray(content)) return open.size;
      for (const b of content) {
        if (ev.type === 'assistant' && b?.type === 'tool_use') open.add(b.id);
        if (ev.type === 'user' && b?.type === 'tool_result') open.delete(b.tool_use_id);
      }
      return open.size;
    },
    get openCount() { return open.size; },
  };
}

// Call start() right after spawning, feed() on every parsed line, and stop() both when
// the result event arrives and when the process closes. A timer left over from a
// finished run can otherwise fire later and "stop" a job that is already done.
export function makeIdleWatch(idleMs, onIdle) {
  const tools = makeToolTracker();
  let timer = null;
  let stopped = false;

  const arm = () => {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    if (tools.openCount === 0) timer = setTimeout(onIdle, idleMs);
  };

  return {
    start: arm,
    feed(ev) { tools.feed(ev); arm(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
    get toolsOpen() { return tools.openCount; },
  };
}
