#!/bin/bash
# Jev Router watchdog — restarts jev_server.py if it stops answering.
# Cron-friendly: silent on success, always exit 0.
if curl -s -m 5 http://127.0.0.1:4319/health >/dev/null 2>&1; then
  exit 0
fi
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.codex/codex-router/jev-watchdog.log"
PYTHON="$(command -v /usr/local/bin/python3 || command -v python3)"
echo "[$(date '+%Y-%m-%dT%H:%M:%S')] server down → restart" >> "$LOG"
cd "$REPO" || exit 1
nohup "$PYTHON" server/jev_server.py >> "$LOG" 2>&1 &
sleep 1.5
if curl -s -m 5 http://127.0.0.1:4319/health >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] restarted OK" >> "$LOG"
else
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] RESTART FAILED" >> "$LOG"
fi
exit 0
