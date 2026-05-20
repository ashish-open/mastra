#!/usr/bin/env bash
#
# kill-zombie-mastra.sh
#
# `mastra dev` spawns a child `node .mastra/output/index.mjs` that does NOT
# get killed when the parent dies (the framework emits the warning
# "SYNCHRONOUS TERMINATION NOTICE" before exiting without running its exit
# hooks). The orphan keeps the DuckDB lock on `mastra.duckdb`, so the next
# `pnpm dev` boot fails with:
#
#   IO Error: Could not set lock on file "...mastra.duckdb":
#   Conflicting lock is held in /usr/local/bin/node (PID xxxxx)
#
# This script is wired as the `predev` npm hook — it scans for any node
# process matching the zombie pattern and SIGTERMs them, then waits a beat
# so the OS releases the file lock. Idempotent + safe in CI.

set -u

ZOMBIE_PATTERNS=(
  '\.mastra/output/index\.mjs'                 # built output the dev parent spawned
  'mastra@.*dist/index\.js dev'                # any prior `mastra dev` parent that was left dangling
)

found=0
for pat in "${ZOMBIE_PATTERNS[@]}"; do
  pids=$(pgrep -f "$pat" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    echo "[predev] killing zombie(s) matching '$pat': $pids"
    kill $pids 2>/dev/null || true
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  # Give the OS a moment to release the DuckDB file lock.
  sleep 1
fi

exit 0
