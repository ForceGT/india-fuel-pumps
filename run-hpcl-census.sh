#!/bin/bash
# ──────────────────────────────────────────────────
# HPCL Full National Census — tmux launch script
# ──────────────────────────────────────────────────
# Usage: bash run-hpcl-census.sh [CONCURRENCY]
#   CONCURRENCY defaults to 10.
#
# Resumable by default — re-running after a crash/sleep picks up where it
# left off. Set HPCL_CENSUS_FRESH=1 to wipe progress and restart from zero.
# ──────────────────────────────────────────────────

set -euo pipefail

CONCURRENCY="${1:-12}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$PROJECT_DIR/output"

if tmux has-session -t hpcl-census 2>/dev/null; then
  echo "ERROR: tmux session 'hpcl-census' already exists."
  echo "  Attach: tmux attach -t hpcl-census"
  echo "  Kill:   tmux kill-session -t hpcl-census"
  exit 1
fi

if [ "${HPCL_CENSUS_FRESH:-0}" = "1" ]; then
  echo "HPCL_CENSUS_FRESH=1 — wiping existing progress..."
  rm -f "$OUTPUT_DIR/hpcl-worklog.jsonl" \
        "$OUTPUT_DIR/hpcl-raw.jsonl" \
        "$OUTPUT_DIR/hpcl-progress.txt" \
        "$OUTPUT_DIR/hpcl-discovered-urls.json"
elif [ -f "$OUTPUT_DIR/hpcl-worklog.jsonl" ] || [ -f "$OUTPUT_DIR/hpcl-discovered-urls.json" ]; then
  echo "Existing census progress found — RESUMING."
  echo "  Set HPCL_CENSUS_FRESH=1 to force a full restart instead."
fi

echo "Launching HPCL census (concurrency=$CONCURRENCY) in tmux session 'hpcl-census'..."

tmux new-session -d -s hpcl-census -c "$PROJECT_DIR" \
  "caffeinate -i env HPCL_CENSUS_CONCURRENCY=$CONCURRENCY npm run census:hpcl; echo ''; echo 'Census finished. Press any key to close.'; read"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Session 'hpcl-census' is running"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Watch live:     tmux attach -t hpcl-census"
echo "  Quick progress: cat $OUTPUT_DIR/hpcl-progress.txt"
echo "  Outlets done:   wc -l $OUTPUT_DIR/hpcl-raw.jsonl"
echo "  Kill it:        tmux kill-session -t hpcl-census"
echo ""
echo "  Detach from tmux: Ctrl+B then D"
echo "  If interrupted: re-run this script — it resumes automatically."
echo ""
