#!/usr/bin/env bash
# Undo scripts/pause.sh: move the plist back into ~/Library/LaunchAgents and bootstrap it.
#
# Usage: scripts/resume.sh <label>
# The paused folder defaults to ~/Library/LaunchAgents-paused (override with PAUSED_DIR).
# It deletes nothing. If a plist with the same label is already in LaunchAgents it stops
# and tells you, rather than choosing between the two copies for you.

set -euo pipefail

label="${1:-}"
if [[ -z "$label" ]]; then
  echo "usage: $0 <launchd label>" >&2
  exit 2
fi
if [[ ! "$label" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "not a valid label: $label" >&2
  exit 2
fi

agents="$HOME/Library/LaunchAgents"
paused="${PAUSED_DIR:-$HOME/Library/LaunchAgents-paused}"
plist="$agents/$label.plist"
src="$paused/$label.plist"
domain="gui/$(id -u)"

if [[ -e "$plist" ]]; then
  echo "refusing: $plist already exists. Compare it with $src by hand." >&2
  exit 1
fi
if [[ ! -f "$src" ]]; then
  echo "no paused plist at $src" >&2
  exit 1
fi

# A plist that does not parse would fail to bootstrap with an unhelpful error; check first.
plutil -lint "$src"

mv -n "$src" "$plist"
launchctl bootstrap "$domain" "$plist"
sleep 1

echo "resumed: $label"
launchctl print "$domain/$label" | grep -E '^\s*(state|pid|last exit code) =' || true
echo "Remember to turn back on anything that watches this worker (a heartbeat alarm)."
