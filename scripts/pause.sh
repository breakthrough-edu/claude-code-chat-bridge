#!/usr/bin/env bash
# Stop a launchd worker for good (Stop cell, docs/launchd.md).
#
# Usage: scripts/pause.sh <label>          e.g. scripts/pause.sh com.example.chat-bridge
#
# Stopping a run is not stopping the worker, and `launchctl bootout` alone is not "for
# good": the plist is still in ~/Library/LaunchAgents, so the next login or reboot loads it
# again. This script does exactly two things:
#   1. bootout the job from your GUI domain (if it is loaded);
#   2. MOVE its plist out of ~/Library/LaunchAgents into a paused folder
#      (default ~/Library/LaunchAgents-paused, override with PAUSED_DIR).
# It deletes nothing and touches no other file. scripts/resume.sh undoes it.
#
# Why not `launchctl disable`: the disabled flag lives inside launchd's own database, where
# `ls ~/Library/LaunchAgents` cannot show it. A paused worker should be visible as paused.

set -euo pipefail

label="${1:-}"
if [[ -z "$label" ]]; then
  echo "usage: $0 <launchd label>   (refusing to guess which worker to stop)" >&2
  exit 2
fi
if [[ ! "$label" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "not a valid label: $label" >&2
  exit 2
fi

agents="$HOME/Library/LaunchAgents"
paused="${PAUSED_DIR:-$HOME/Library/LaunchAgents-paused}"
plist="$agents/$label.plist"
dest="$paused/$label.plist"
domain="gui/$(id -u)"

loaded() { launchctl print "$domain/$label" >/dev/null 2>&1; }

if [[ ! -f "$plist" ]]; then
  if [[ -f "$dest" ]]; then
    echo "already paused: $dest"
    loaded && echo "WARNING: but $label is still loaded. Run: launchctl bootout $domain/$label" >&2
    exit 0
  fi
  echo "no plist at $plist" >&2
  exit 1
fi
if [[ -e "$dest" ]]; then
  echo "refusing: $dest already exists. Look at it and move it aside by hand first." >&2
  exit 1
fi

# 1. Unload.
if loaded; then
  launchctl bootout "$domain/$label"
  for _ in $(seq 1 20); do loaded || break; sleep 0.5; done
  if loaded; then
    echo "bootout did not take effect; plist left where it was" >&2
    exit 1
  fi
  echo "booted out: $domain/$label"
else
  echo "not loaded: $label (nothing to boot out)"
fi

# 2. Move the plist out, so a login or reboot cannot load it again.
mkdir -p "$paused"
mv -n "$plist" "$dest"
if [[ -e "$plist" || ! -f "$dest" ]]; then
  echo "move failed; check $plist and $dest" >&2
  exit 1
fi

echo "paused:   $label"
echo "plist in: $dest"
echo "check:    ls $agents | grep -F $label   (should print nothing)"
echo "Remember anything that watches this worker (a heartbeat alarm): pause it too, or it will alert on the silence."
