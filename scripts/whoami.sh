#!/usr/bin/env bash
# Find your own sender id under THIS bot app, for BRIDGE_ALLOWED_USERS (docs/lark-setup.md).
#
# Usage: scripts/whoami.sh [profile]
#   profile   the lark-cli profile of the bot app (default: $LARK_PROFILE, else lark-cli's default)
#   LARK_CLI  path to lark-cli (default: the one on PATH)
#
# It listens for ONE message to the bot, prints the sender's id, the chat type and the chat
# id, and exits. In a group, @-mention the bot: the mentioned ids are printed too, and the
# bot's own id among them is the value for BRIDGE_BOT_ID. Ids are per app: the same person has a different open_id under each bot app,
# so run this against the app the bridge will use.
#
# It refuses to start while another consumer for the same event and profile is running on
# this machine (your bridge, for example): two consumers on one app split the events
# between them, and each would see only some of the messages. Pause the bridge first.
#
# The consumer's stdin is held open (a stream command treats stdin EOF as "stop"), and it
# is stopped with SIGTERM when this script ends, never with SIGKILL.
# Gives up after 5 minutes (WHOAMI_TIMEOUT_S overrides, in seconds).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

profile="${1:-${LARK_PROFILE:-}}"
lark="${LARK_CLI:-$(command -v lark-cli || true)}"
key="im.message.receive_v1"
timeout_s="${WHOAMI_TIMEOUT_S:-300}"

if [[ -z "$lark" ]]; then
  echo "lark-cli not found: put it on PATH or set LARK_CLI to its absolute path" >&2
  exit 2
fi
if [[ -n "$profile" && ! "$profile" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "not a valid profile name: $profile" >&2
  exit 2
fi

# 1. Refuse if a consumer for the same event key and profile is already running.
same_consumer() {
  local cmd="$1"
  [[ "$cmd" == *"event consume $key"* ]] || return 1
  if [[ -n "$profile" ]]; then
    [[ "$cmd" == *"--profile $profile"* ]]
  else
    [[ "$cmd" != *"--profile"* ]]
  fi
}
for pid in $(pgrep -f "event consume $key" || true); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  if same_consumer "$cmd"; then
    echo "refusing: a consumer for $key${profile:+ on profile $profile} is already running (pid $pid):" >&2
    echo "  $cmd" >&2
    echo "Two consumers on one app split the events. Stop that one first (for the bridge: scripts/pause.sh <label>)." >&2
    exit 1
  fi
done

# 2. Start the consumer: stdin from a FIFO this script holds open, output into another FIFO.
work="$(mktemp -d)"
mkfifo "$work/in" "$work/out"
exec 4<>"$work/in"                 # read-write, so opening it never blocks and never hits EOF

args=(event consume "$key" --as bot)
if [[ -n "$profile" ]]; then args+=(--profile "$profile"); fi
"$lark" "${args[@]}" <"$work/in" >"$work/out" 2>&1 &
consumer=$!
disown "$consumer" 2>/dev/null || true     # no job-control chatter when it is stopped
exec 5<"$work/out"

cleanup() {
  if kill -0 "$consumer" 2>/dev/null; then
    kill -TERM "$consumer" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$consumer" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$consumer" 2>/dev/null; then
      echo "warning: the consumer (pid $consumer) did not stop after SIGTERM; stop it by hand" >&2
    fi
  fi
  exec 4>&- 5<&- || true
  rm -f "$work/in" "$work/out"
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT

# 3. Read until the first message event, or the deadline.
echo "Connecting${profile:+ with profile $profile}..."
deadline=$((SECONDS + timeout_s))
ready=0
printed=""                          # non-event output, for the error report if the consumer dies
while true; do
  remaining=$((deadline - SECONDS))
  if (( remaining <= 0 )); then
    echo "No message within $timeout_s s. Check that the bot can receive direct messages, then run this again." >&2
    exit 3
  fi
  if IFS= read -r -t "$remaining" line <&5; then
    if [[ "$line" == *"[event] ready"* ]]; then
      if (( ready == 0 )); then
        ready=1
        echo "Listening. Send the bot any direct message now."
      fi
      continue
    fi
    if [[ "$line" == "{"*'"sender_id"'* ]]; then
      # Parse with node (already needed by the bridge). Only ids are printed, never content.
      node -e '
        const e = JSON.parse(process.argv[1]);
        console.log("sender_id: " + e.sender_id);
        console.log("chat_type: " + e.chat_type);
        console.log("chat_id: " + e.chat_id);
        if (e.chat_type !== "p2p") {
          console.log("(That was not a direct message. The sender id is still yours; the bridge answers groups only when @-mentioned.)");
          for (const m of e.mentions || []) console.log("mentioned: " + m.id + (m.name ? " (" + m.name + ")" : ""));
          if ((e.mentions || []).length) {
            console.log("The mentioned id that belongs to the bot is its own id: that one goes in BRIDGE_BOT_ID.");
          }
        }
        console.log("Put the sender_id in BRIDGE_ALLOWED_USERS.");
      ' "$line"
      exit 0
    fi
    # Anything else (an error report, a notice) is kept for the diagnosis below.
    printed+="$line"$'\n'
  else
    # A failed read is either a timeout or the end of the consumer's output. Bash 3.2 (the
    # macOS default) returns 1 for both, so ask whether the consumer is still alive.
    if kill -0 "$consumer" 2>/dev/null; then continue; fi   # timeout: the loop checks the deadline
    # The consumer is gone. Lark's error report is pretty-printed JSON over many lines; the
    # bridge's own parser pulls out the message, code and hint.
    PRINTED="$printed" node --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const { findErrorReport, describeFatal } = await import(pathToFileURL(process.argv[1]));
      const err = findErrorReport(process.env.PRINTED);
      if (err) console.error("lark-cli: " + describeFatal("im.message.receive_v1", err, "?"));
      else console.error(process.env.PRINTED.trim() || "(no output)");
    ' "$here/../bridge/platform-lark.mjs" || printf '%s' "$printed" >&2
    echo "The consumer exited before a message arrived." >&2
    exit 1
  fi
done
