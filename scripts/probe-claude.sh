#!/usr/bin/env bash
# The clean-env probe: run one tiny `claude -p` the way the bridge runs it, and print what
# the runtime reports (Proof cell, docs/proof.md).
#
# Usage: scripts/probe-claude.sh [path-to-claude]
#   The claude path comes from the argument, else $CLAUDE_BIN, else `command -v claude`.
#   PROBE_MODEL picks the model (default claude-sonnet-5, the bridge's default).
#   The flags are the bridge's (bridge/run-claude.mjs), minus --resume.
#
# It prints the init event's tools and permissionMode and compares them with what the
# bridge asks for, then prints the result. Exit code: 0 cage matches and the run worked,
# 1 cage mismatch, 3 the run failed (read the diagnosis it prints).
#
# "OAuth session expired" has two causes that look identical:
#   - an env bug: the child env lacks USER or SHELL, so claude cannot find your login in the
#     keychain. The probe below sets both. If it works, your login is fine and the bug is
#     in the env your bridge builds.
#   - a real expiry, or a plan limit reached. Then the probe fails too, and so does the
#     second probe with your full terminal env. Run `claude` interactively and check.
#
# Run this from a normal terminal. Not over SSH (no access to the GUI keychain), and not
# from inside another agent's sandboxed shell: both give a false login error ("Not logged
# in", or "OAuth session expired").

set -euo pipefail

claude_bin="${1:-${CLAUDE_BIN:-}}"
if [[ -z "$claude_bin" ]]; then
  claude_bin="$(command -v claude || true)"
fi
if [[ -z "$claude_bin" || "$claude_bin" != /* ]]; then
  echo "pass the absolute path to claude (run: which -a claude, use the line that starts with /)" >&2
  exit 2
fi

wanted_tools="Read,Edit,Write,Glob,Grep"          # keep in step with WANTED in bridge/run-claude.mjs
wanted_mode="acceptEdits"
scratch="$(mktemp -d)"                            # an empty working dir, removed at the end
trap 'rm -rf "$scratch"' EXIT

args=(-p "Reply with the single word ok. Do not use any tools."
      --output-format stream-json --verbose --include-partial-messages
      --permission-mode "$wanted_mode" --strict-mcp-config --tools "$wanted_tools"
      --model "${PROBE_MODEL:-claude-sonnet-5}")

# Probe 1: the scrubbed env, exactly the variables the bridge passes.
set +e
(cd "$scratch" && env -i HOME="$HOME" USER="${USER:-$(id -un)}" SHELL=/bin/zsh \
  PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin TERM=xterm LANG="${LANG:-en_US.UTF-8}" \
  "$claude_bin" "${args[@]}") >"$scratch/out.jsonl" 2>"$scratch/err.txt"
code=$?
set -e

summarise() {
  node -e '
    const fs = require("fs");
    const [file, wantedTools, wantedMode] = process.argv.slice(1);
    let init = null, result = null;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "system" && ev.subtype === "init") init = ev;
        if (ev.type === "result") result = ev;
      } catch {}
    }
    if (init) {
      const loaded = [...init.tools].sort().join(",");
      const wanted = wantedTools.split(",").sort().join(",");
      console.log("init tools:          " + loaded);
      console.log("init permissionMode: " + init.permissionMode);
      const ok = loaded === wanted && init.permissionMode === wantedMode;
      console.log("cage:                " + (ok ? "MATCH" : "MISMATCH (wanted " + wanted + " / " + wantedMode + ")"));
      if (!ok) process.exitCode = 1;
    } else {
      console.log("init:                none seen");
    }
    if (result) {
      console.log("result is_error:     " + result.is_error);
      console.log("result num_turns:    " + result.num_turns);
      console.log("result text:         " + String(result.result || "").slice(0, 300));
      console.log("permission_denials:  " + JSON.stringify(result.permission_denials || []));
      if (result.is_error && !process.exitCode) process.exitCode = 3;
    } else {
      console.log("result:              none seen");
      if (!process.exitCode) process.exitCode = 3;
    }
  ' "$1" "$wanted_tools" "$wanted_mode"
}

echo "== probe 1: clean env with USER and SHELL (what the bridge uses), exit $code"
set +e
summarise "$scratch/out.jsonl"
verdict=$?
set -e
if [[ -s "$scratch/err.txt" ]]; then
  echo "stderr: $(head -c 400 "$scratch/err.txt")"
fi

if [[ $verdict -eq 0 ]]; then
  echo "OK: login works in a clean env and the cage matches. If your bridge still says"
  echo "'OAuth expired', compare the env it builds with the one above."
  exit 0
fi
if [[ $verdict -eq 1 ]]; then
  echo "CAGE MISMATCH: the runtime loaded something other than what was asked for. Do not"
  echo "run the bridge until this matches (check the CLI version and your global settings)."
  exit 1
fi

# Probe 2: only if probe 1 failed. Same command with your full terminal env, to split
# "env bug" from "real login problem".
echo
echo "== probe 2: same command, your full terminal env"
set +e
(cd "$scratch" && "$claude_bin" "${args[@]}") >"$scratch/out2.jsonl" 2>"$scratch/err2.txt"
summarise "$scratch/out2.jsonl"
verdict2=$?
set -e
if [[ -s "$scratch/err2.txt" ]]; then
  echo "stderr: $(head -c 400 "$scratch/err2.txt")"
fi

if [[ $verdict2 -eq 0 || $verdict2 -eq 1 ]]; then
  echo "DIAGNOSIS: works with your terminal env, fails with the clean one. An env problem,"
  echo "not your login. Check USER, SHELL and HOME in the clean env above."
else
  echo "DIAGNOSIS: fails in both. A real login problem or a plan limit. Read the result text"
  echo "and stderr above, then run claude interactively to log in again or check your usage."
fi
exit 3
