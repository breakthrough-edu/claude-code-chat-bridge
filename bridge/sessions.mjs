// Session continuity (docs/sessions-and-groups.md).
//
// A map of conversation -> claude session id, persisted so threads survive restarts.
// For a DM the key is the user; for a group it is the chat, so every group has its own thread.
//
// The one rule that matters: only store a session id from a SUCCESSFUL run. A dead
// `--resume` echoes the dead id back inside an error result; store that and every later
// message fails the same way until someone sends /new.

import { readJson, writeJsonAtomic } from './state-file.mjs';

export function sessionKey(msg) {
  return msg.chatType === 'group' ? `chat:${msg.chatId}` : `user:${msg.userId}`;
}

export function openSessions(file) {
  const map = readJson(file, {});
  const save = () => writeJsonAtomic(file, map);

  return {
    get: (key) => map[key],

    delete(key) {
      if (key in map) { delete map[key]; save(); }
    },

    // Store the id only when the run really succeeded and its cage was verified.
    // Returns true when something was stored.
    recordResult(key, result) {
      const ok = result && !result.isError && !result.cageBreach && !result.stoppedReason && result.sessionId;
      if (!ok) return false;
      map[key] = result.sessionId;
      save();
      return true;
    },
  };
}
