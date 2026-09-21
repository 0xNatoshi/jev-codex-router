#!/bin/bash
# Jev Router watchdog — restarts jev_server.py if it stops answering.
# Cron-friendly: silent when healthy, nonzero when recovery fails.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$(command -v /usr/local/bin/python3 || command -v python3)"
if "$PYTHON" "$REPO/server/healthcheck.py"; then
  exit 0
fi
LOG="$HOME/.codex/codex-router/jev-watchdog.log"
echo "[$(date '+%Y-%m-%dT%H:%M:%S')] server down → restart" >> "$LOG"
cd "$REPO" || exit 1
nohup "$PYTHON" server/jev_server.py >> "$LOG" 2>&1 &
sleep 1.5
if "$PYTHON" "$REPO/server/healthcheck.py"; then
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] restarted OK" >> "$LOG"
else
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] RESTART FAILED" >> "$LOG"
  exit 1
fi
exit 0
