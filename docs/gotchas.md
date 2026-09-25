# The gotchas that will bite you

*The failures that don't show up until you run under launchd on a fresh machine, or until the first real message after launch.*

Written against Claude Code 2.1.240 (September 2026). Gotchas 11 to 24 were added in v2. Where the behaviour belongs to a tool that changes between versions, the entry names the version it applies to. **Untested on your setup:** most gotchas say how to check them on your machine; do that before you trust one. Four of them (#3, #5, #7, #16) are about launchd and macOS privacy, and their full text lives in [launchd.md](launchd.md); the numbers are kept so that references to "gotcha #5" still land.

---

## From the September 2026 README

**1. "OAuth session expired" usually isn't. Put `USER` and `SHELL` in the child's env.**
If you spawn `claude -p` with a hand-built minimal env that lacks `USER` and `SHELL`, it cannot find your login in the keychain and reports `Failed to authenticate: OAuth session expired and could not be refreshed` (or "Not logged in"). Your login is fine. The June version of this guide had exactly this bug in its `CLEAN_ENV`. Also scrub the rest: if you spawn from inside another agent or automation context, inherited vars (a gateway base URL, OAuth-helper vars) can redirect it to an endpoint it has no token for. To tell a real expiry from this one, run a one-line `claude -p` probe with `HOME PATH LANG TERM USER SHELL` set: if that works, your env was the problem. (Two more ways to get the same message, one of them real, are #12 and #13.)

**2. Test headless Claude through launchd, not over SSH.**
A process started from an SSH session cannot reach the GUI login keychain, so `claude -p` fails there with "Not logged in" even when the same bridge started by launchd works. Verify a deployed bot by sending it a real message and reading its log.

**3. macOS TCC / Full Disk Access is per-binary, per-machine, and does NOT migrate or sync.**
A launchd agent does not inherit the privacy grant your Terminal has; grant Full Disk Access to the launch binary itself, on every machine. Full text, including the symptoms it masquerades as and the diagnostic that cracks it: [launchd.md](launchd.md#full-disk-access-tcc-is-per-binary-per-machine-and-does-not-migrate-or-sync).

**4. The CLI flag beats the global permission default, but `--settings` files merge.**
`--permission-mode` on the command line wins over `defaultMode` in `~/.claude/settings.json`. A `--settings` file, however, is merged with the global one: hooks from both run. Plan for that in both directions.

**5. After granting Full Disk Access, fully re-bootstrap the job: `kickstart` is not enough.**
`bootout`, then `bootstrap` again. Full text: [launchd.md](launchd.md#after-granting-full-disk-access-fully-re-bootstrap-the-job-kickstart-is-not-enough).

**6. Under launchd, run shell scripts as in-memory `bash -c`, not as a file argument.**
macOS ships an old `/bin/bash` (3.2). Reading a script *file* incrementally under launchd can have its `read()` interrupted and not restarted (EINTR), deterministically. Pass the script body as an in-memory program instead:

```js
import { readFileSync } from 'node:fs';
spawn('/bin/bash', ['-c', readFileSync('pipeline.sh', 'utf8'), 'pipeline', input],
      { detached: true /* own process group so timeouts can kill the whole tree */ });
```

(Also remember launchd's PATH is minimal: prepend `/opt/homebrew/bin` if your tools live there.)

**7. A plist that points into `~/Documents` works until the first cold boot.**
After a cold reboot the job refuses to start with `last exit code = 78: EX_CONFIG` and an empty stderr. Full text: [launchd.md](launchd.md#a-plist-that-points-into-documents-works-until-the-first-cold-boot).

**8. Measure before blaming "background throttling".**
A task that feels slow under launchd can look like QoS throttling. Time the same task interactively and under launchd before you conclude anything: more often the real issue is a too-tight timeout for a task with normal variance. The silence watchdog in [runs.md](runs.md#tell-slow-from-stuck) is the better fix than any fixed timeout.

**9. `claude -p` may refuse to fake a long wait, and that is correct.**
Asking the bot to run a long `sleep` is not a way to test the watchdog. Claude Code blocks long leading sleeps, and the model may decline a `python -c "time.sleep(...)"` rewrite as a way around that block. Test the watchdog offline with a fake child process that prints stream-json on a compressed clock, and let a real long job prove it in production. (The reference implementation's offline suite does this with `bridge/test/fake-claude.mjs`.)

**10. `--allowedTools` is not a restriction.**
This was wrong in the June version of this guide. `--allowedTools` pre-approves tools; it does not unload the rest. `--allowedTools Read Grep Glob` still loads far more than those three tools, including ones that can start sub-agents (`Workflow`), message other sessions (`SendMessage`) and schedule jobs (`CronCreate`). A denylist has the opposite problem: it only closes what you name, and a CLI update can add tools it has never heard of. Use `--tools` and check the init event (README §5).

---

## Added in v2

**11. A hook that never returns will hold a headless run forever.** *(Applies to Claude Code 2.1.240.)*
Your global `~/.claude/settings.json` applies to headless runs too, hooks included (#4). A hook that never returns (for example one that waits on audio or a prompt, which a launchd job does not have) holds the run. The symptom: the assistant's answer is written within seconds, and then no `result` event ever arrives, so the bot looks silent or very slow. Do not count on a hook timeout to release it.
- First move: `pgrep -P <claude pid>` to list its children. The one that never exits is the culprit. After you kill `claude`, that child can linger as an orphan, which is one more reason `stop()` kills the whole process group ([runs.md](runs.md)).
- Fix it in the **global** settings file, because every headless job on the machine reads it. A `--settings` file with `"disableAllHooks": true` does override the global value (a single value overrides; hook arrays merge), but it only protects the one job that passes that file, and it is easy to write the fix and never deploy it to the path that actually runs.
- `--bare` is not an escape: it skips hooks, and it also skips your login, so it answers "Not logged in".

**12. Running `claude -p` from inside an agent's sandboxed shell gives a false "OAuth session expired".** *(Applies to Claude Code 2.1.240.)*
If you test the bridge's `claude -p` call from inside another AI agent's shell tool with a sandbox on (Claude Code's own Bash tool, for example), the sandbox blocks the keychain and you get the same message as #1. Your login is fine. Run the probe from a normal terminal, or through launchd, before you conclude anything about your login.

**13. "OAuth session expired" can also be real. One probe decides.** *(Applies to Claude Code 2.1.240.)*
Sometimes the CLI login really has dropped (for example around hitting a usage limit), and then every headless job reports the same line at once. The fix for that is to log in again interactively. To tell which case you are in, run a `claude -p` probe with a clean env that includes `USER` and `SHELL` (#1), from a normal terminal (#12), not over SSH (#2): `is_error: false` means your bridge's env was the problem; an error means log in again. `scripts/probe-claude.sh` is that probe. Do not try to judge login state by reading keychain entries: a stale entry can look empty while the login works.

**14. launchd adds `USER` and `SHELL` for you. Check the live process, not the plist.** *(Applies to macOS 26.)*
A user LaunchAgent gets `USER` and `SHELL` in its environment even when the plist's `EnvironmentVariables` does not list them, so "my plist has no `USER` and it works" is not a contradiction of #1. To see the environment a job really has, inspect the running process (`ps eww -p <pid>` on macOS), not the plist. And this does not help your `claude` child: `cleanEnv()` in README §5 builds the child's env by hand, so it still needs `USER` and `SHELL` written into it.

**15. `import()` of your bot file starts the bot.**
A "quick load check" that does `import('./bridge.mjs')` runs its top-level code, which opens a second consumer on the same bot app. Two consumers compete for the same event stream, so the running bot starts missing messages, and the check leaves a process behind. To check that a file loads, use `node --check bridge.mjs`, which parses without running. In the reference implementation `bridge/bridge.mjs` is only the entry point and starts `main()` only when executed directly; the loop itself lives in `bridge/loop.mjs`, which the tests import. The habit is still the right one.

**16. A launchd program's Full Disk Access may not reach its child processes.** *(Applies to macOS 26.)*
With python as the launchd program, its children can stall on protected paths with zero output and zero CPU; node as the parent avoids it. Full text and the diagnostic: [launchd.md](launchd.md#child-processes-and-full-disk-access).

**17. A scheduled job's first start must decide whether today already ran.**
If you add a timed task to the bridge (a morning briefing, a nightly summary) with the rule "if it is past the scheduled time and there is no record for today, run it", then every daytime restart runs it on the spot, including every `kickstart` after a code edit. A nightly job run at noon works on half a day's data, and ten restarts in an afternoon run it ten times. On startup, if the scheduled time has already passed and there is no record for today, write today as done and wait for the next scheduled time; catching up should be an explicit command. Write the "last run" record on the very first start, so an empty value can never be read as "due". Before launch, run the schedule once on a fake clock and check what it does at three moments: just started, just past the scheduled time, and across midnight.

**18. Feed any parser of model output one real model output before launch.**
A parser or validator that reads what the model wrote (JSON for a card draft, a header block, a list) passes every fixture you wrote by hand, because you wrote the fixtures the way you expected the model to write. Real output differs in ways you did not think of: a block list where you expected an inline one, a quoted value, an extra harmless key, an unescaped quotation mark inside a string that breaks the JSON. So:
- before launch, call the real model once, save its raw output as a test fixture, and run the parser on it;
- validate the syntax, not your house spelling: accept every legal way to write the same value, and refuse only what is actually wrong;
- when parsing fails, save the model's raw output to disk, and keep a repair path (a tolerant second parse) before you give up;
- for a structured draft, such as the one behind an approval card, consider asking for it with `--json-schema`, which `claude --help` lists on 2.1.240. Untested on your setup: verify by running one real draft through your parser, and keep the repair path either way.

**19. Do not let the model do date arithmetic.**
Asked to turn "Friday" into a date on a Tuesday, a model can pick the wrong Friday. And in JavaScript, `new Date().toISOString()` for "today" is off by a day for part of every day whenever the local time zone is not UTC (in a time zone ahead of UTC, for the first hours after local midnight). Resolve dates in code, in the right time zone, and hand the model the resolved string.

**20. Sending model output as Lark markdown can make the bridge fetch a URL the model chose.** *(Applies to lark-cli 1.0.89.)*
lark-cli's `--markdown` send option resolves image URLs it finds in the text, which means a fetch from your machine. The text is the model's reply, and the model's input includes whatever the sender (or, in a group, anyone in the chat) typed, so a prompt can steer the model into writing an image link to an address of the attacker's choosing, and your bridge will request it. That leaks that the bot is alive, from where, and anything placed in the URL. Neutralise image links in the reply before it is sent, or render the message content yourself and send it without the markdown option.

The reference implementation neutralises them: `neutraliseImageLinks(text)` in `bridge/platform-lark.mjs` runs in `sendMessage` before the `--markdown` send, and in `renderCard`, so `sendCard` and `updateCard` are covered too.
- Inline images (`![alt](url)`), reference-style images (`![alt][ref]`, `![alt][]`, and `![alt]` with a matching definition) and HTML `<img>` tags become `[image: alt]` followed by the URL in inline code, so you can still see and copy the address, but nothing fetches it.
- Ordinary links (`[text](url)`) are left alone.
- Images inside code fences are neutralised too, on purpose: the fence is model output like everything else.
- A last pass breaks any `![` or `<img` the patterns did not recognise (into `! [` and `&lt;img`), so a malformed image cannot slip through.

The offline tests for it are in `bridge/test/platform-lark.test.mjs`. If you write your own platform file, do the same in every send path that renders markdown. **Untested on your setup** is the underlying claim that lark-cli fetches image URLs: verify it by having the bot reply with an image link to a server you control and watching that server's access log.

**21. Dedupe Lark messages on `message_id`, not `event_id`.** *(Applies to lark-cli 1.0.89.)*
Lark's event schema says the same message can be delivered again under a new `event_id`, so a list of handled event ids lets a redelivered message through and runs the job twice. Key the handled-ids list on `message_id`. The reference `bridge/platform-lark.mjs` passes `message_id` up as the id the loop dedupes on, falling back to other ids only when an event carries no `message_id`. Card taps have no message of their own, so they are keyed on the callback's event id. Persisting that list across restarts is the Identity cell ([identity.md](identity.md)). Untested on your setup: verify by checking which field your own consumer logs as the dedupe key.

**22. Replayed transcripts give upper bounds, not watchdog settings.**
Replaying your own `~/.claude/projects/*/*.jsonl` through the watchdog's logic ([runs.md](runs.md#tell-slow-from-stuck)) has two traps. First, a resumed or rewound session appends copies of earlier rows to the same file, so a naive replay counts the same gap twice or sees time jump backwards; skip rows whose `uuid` you have already seen. Second, an interactive session is not a headless one: a tool call's time includes any permission prompt that waited for you and your own think time, and a transcript stores the finished message rather than the partial text a live `--include-partial-messages` run streams, so a long answer looks like one long silence. Treat the longest gap and the longest tool call as upper bounds, look at the top few entries by hand, and set limits comfortably above what a headless run would really show. `scripts/replay-transcripts.mjs` skips repeated `uuid`s and prints both numbers; it cannot remove the interactive time for you.

**23. `node --test <directory>` fails on Node 24. Pass the test files.**
On Node 24, pointing `node --test` at a directory fails instead of finding the tests inside it. Pass a glob of test files instead: `node --test bridge/test/*.test.mjs`, which is what `npm test` runs in this repo. The glob also keeps helper files such as fakes out of the run. Untested on your setup: verify with `node --version` and one run of `npm test`.

**24. Error 20069, "The specified app is not enabled", is the Lark console, not your code.** *(Applies to lark-cli 1.0.89.)*
It means the bot app was disabled in the developer console (a deleted app likely gives the same error; unverified on your setup). lark-cli prints a multi-line JSON error report and exits with code 3; the reference bridge treats three such failures within a minute as fatal: within a few seconds it logs one `FATAL:` line quoting Lark's message, code and hint, marks both listeners down in the heartbeat file, shuts down and exits with code 1. Under launchd, `KeepAlive` then starts it again, so the same `FATAL` repeats in the log. Re-enable the app in the console (or pause the worker) instead of changing code. Details in [lark-setup.md](lark-setup.md#8-when-the-app-is-disabled-error-20069). When the bot goes quiet, read the last lines of the bridge log first.

---

## Checklist lines this chapter adds

- [ ] Scrubbed env that still includes `USER` and `SHELL`; checked on the live process with `ps eww`, not in the plist.
- [ ] Login state judged only by the clean-env probe (`scripts/probe-claude.sh`), run from a normal terminal, never over SSH and never from a sandboxed agent shell.
- [ ] Global `~/.claude/settings.json` read line by line: no hook that can wait forever under launchd.
- [ ] Load checks use `node --check`, never `import()` of the bot file.
- [ ] Shell scripts under launchd run as in-memory `bash -c`.
- [ ] Any timed task decides on startup whether today already ran, and defaults to not catching up.
- [ ] Every parser of model output tested on one saved real model output; raw output saved on a parse failure.
- [ ] Dates resolved in code before they reach the model.
- [ ] Image links neutralised in model replies on every markdown send path (messages and cards).
- [ ] Handled-ids list keyed on `message_id`, not `event_id`.
- [ ] Watchdog limits set above replay results read as upper bounds, with repeated `uuid`s skipped.
- [ ] Tests run as `node --test bridge/test/*.test.mjs` (a glob), not a directory.
- [ ] A `FATAL` with 20069 in the log is checked in the Lark console before any code is changed.
