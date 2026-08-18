#!/bin/sh
set -e

# Clean up a stale Xvfb lock from a previous crashed run in the same
# container (Railway restarts the process in-place on crash without always
# recreating the filesystem, so /tmp can carry over a dead lock file).
rm -f /tmp/.X99-lock

Xvfb :99 -screen 0 1366x900x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Give Xvfb a moment to actually bind the display before Chrome tries to use it.
sleep 2

cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node backend/server.cjs
