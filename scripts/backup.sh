#!/usr/bin/env bash
# Dated backup before you change a file (Rollback cell, docs/rollback.md).
#
# Usage: scripts/backup.sh <file> <label>
#   Copies <file> to <file>.bak-<label>-<YYYY-MM-DD> next to it (adds the time if that name
#   is taken), then prints the md5 of both so you can write down which version is current.
#   It never overwrites an existing backup and never touches the original.
#
# Restore is the same copy in the other direction, then /restart the bridge. Remember that
# restoring a source does not update copies already published from it (a plist's env,
# a pinned message, a card template).

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <file> <label>" >&2
  exit 2
fi

file="$1"
label="$2"

if [[ ! "$label" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "label may only contain letters, digits, dot, underscore and hyphen" >&2
  exit 2
fi
if [[ ! -f "$file" ]]; then
  echo "not a file: $file" >&2
  exit 1
fi

dest="${file}.bak-${label}-$(date +%Y-%m-%d)"
if [[ -e "$dest" ]]; then
  dest="${file}.bak-${label}-$(date +%Y-%m-%d-%H%M%S)"
fi
if [[ -e "$dest" ]]; then
  echo "refusing to overwrite $dest" >&2
  exit 1
fi

cp -p "$file" "$dest"

md5_of() {
  if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | cut -d' ' -f1; fi
}

echo "backup:   $dest"
echo "md5 now:  $(md5_of "$file")  $file"
echo "md5 bak:  $(md5_of "$dest")  $dest"
