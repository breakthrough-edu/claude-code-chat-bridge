// Identity (docs/identity.md): what the bridge has already handled, kept on disk.
//
// Two things live here, in one JSON file written atomically:
//   1. inbound ids already handled (bounded), so a redelivered message is dropped even
//      after a restart. An in-memory set forgets everything on restart.
//   2. a job ledger: each job moves received -> running -> replying -> done | failed | stopped.
//      `replying` means the run is over and its outcome is known, but the reply has not
//      been confirmed sent. The final state is written only after the send succeeded.
//      A job still marked `running` at startup means the bridge died mid-run. That job
//      may have written half its work already, so it is NOT rerun: it is marked
//      `interrupted` and the user is told. Rerunning would risk doing the same write twice.
//      A job still `replying` finished its work but its reply may never have arrived; it is
//      also marked `interrupted` (never rerun), and the user is asked to ask again.
//      A job still `received` never started, so nothing happened; it is marked `dropped`
//      and the user is asked to resend if they still want it.
//
// It also records the pid of the running claude child, so startup can kill an orphan
// process group left behind by a crash (the child is detached and outlives the bridge).

import { readJson, writeJsonAtomic } from './state-file.mjs';

export const MAX_SEEN_IDS = 2000;   // enough for days of chat; oldest ids fall off first
export const MAX_JOBS = 200;        // finished jobs kept for inspection, oldest dropped first

export const JOB_STATES = ['received', 'running', 'replying', 'done', 'failed', 'stopped', 'interrupted', 'dropped'];
const UNFINISHED = ['received', 'running', 'replying'];

export function openLedger(file, { maxSeen = MAX_SEEN_IDS, maxJobs = MAX_JOBS } = {}) {
  const state = readJson(file, null) || { seen: [], jobs: [], runningPid: null };
  const seen = new Set(state.seen);

  const save = () => {
    // Trim before writing so the file stays small.
    while (state.seen.length > maxSeen) seen.delete(state.seen.shift());
    const finished = (j) => !UNFINISHED.includes(j.state);
    while (state.jobs.length > maxJobs) {
      const i = state.jobs.findIndex(finished);
      if (i < 0) break;                     // never drop an unfinished job
      state.jobs.splice(i, 1);
    }
    writeJsonAtomic(file, state);
  };

  const find = (id) => state.jobs.find((j) => j.id === id);

  return {
    hasSeen: (id) => seen.has(id),

    // Mark an inbound id handled BEFORE acting on it: if the bridge dies mid-run, a
    // redelivery of the same message must not start the same job again.
    markSeen(id) {
      if (seen.has(id)) return;
      seen.add(id);
      state.seen.push(id);
      save();
    },

    addJob(job) {
      state.jobs.push({ ...job, state: 'received', receivedAt: new Date().toISOString() });
      save();
    },

    setState(id, next, extra = {}) {
      if (!JOB_STATES.includes(next)) throw new Error(`unknown job state ${next}`);
      const job = find(id);
      if (!job) return;
      Object.assign(job, extra, { state: next, [`${next}At`]: new Date().toISOString() });
      save();
    },

    getJob: find,
    jobs: () => state.jobs.slice(),

    recordPid(pid) { state.runningPid = pid; save(); },
    clearPid() { state.runningPid = null; save(); },
    get runningPid() { return state.runningPid; },

    // Called once at startup, before anything new is processed. Returns the jobs that
    // need a message to their user.
    recoverAfterRestart() {
      const notices = [];
      for (const job of state.jobs) {
        if (job.state === 'running' || job.state === 'replying') {
          job.interruptedWhile = job.state;
          job.state = 'interrupted';
          job.interruptedAt = new Date().toISOString();
          notices.push(job);
        } else if (job.state === 'received') {
          job.state = 'dropped';
          job.droppedAt = new Date().toISOString();
          notices.push(job);
        }
      }
      if (notices.length) save();
      return notices;
    },
  };
}
