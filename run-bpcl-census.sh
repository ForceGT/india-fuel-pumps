#!/bin/bash
# ──────────────────────────────────────────────────
# BPCL Full National Census — tmux launch script
# ──────────────────────────────────────────────────
# Usage: bash run-bpcl-census.sh [CONCURRENCY]
#   CONCURRENCY defaults to 4. Runtime: ~25min at concurrency 4 — this is
#   NOT an overnight job like HPCL/IOCL. Two phases run automatically:
#   route-mesh (~5 min) for speed, then adaptive grid for national coverage.
#
# Works on macOS (caffeinate) and Termux/Android (termux-wake-lock). Falls
# back to running unlocked with a warning if neither is available.
#
# Resumable by default — re-running after a crash picks up where it left off.
# Set BPCL_CENSUS_FRESH=1 to wipe progress and restart from zero.
# ──────────────────────────────────────────────────

set -euo pipefail

CONCURRENCY="${1:-4}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$PROJECT_DIR/output"

if tmux has-session -t bpcl-census 2>/dev/null; then
  echo "ERROR: tmux session 'bpcl-census' already exists."
  echo "  Attach: tmux attach -t bpcl-census"
  echo "  Kill:   tmux kill-session -t bpcl-census"
  exit 1
fi

if [ "${BPCL_CENSUS_FRESH:-0}" = "1" ]; then
  echo "BPCL_CENSUS_FRESH=1 — wiping existing progress..."
  rm -f "$OUTPUT_DIR/bpcl-worklog.jsonl" \
        "$OUTPUT_DIR/bpcl-raw.jsonl" \
        "$OUTPUT_DIR/bpcl-progress.txt"
elif [ -f "$OUTPUT_DIR/bpcl-worklog.jsonl" ]; then
  echo "Existing census progress found — RESUMING."
  echo "  Set BPCL_CENSUS_FRESH=1 to force a full restart instead."
fi

RUN_CMD="env BPCL_CENSUS_CONCURRENCY=$CONCURRENCY npm run census:bpcl"

if command -v caffeinate >/dev/null 2>&1; then
  echo "Launching BPCL census (concurrency=$CONCURRENCY) in tmux session 'bpcl-census' (caffeinate)..."
  tmux new-session -d -s bpcl-census -c "$PROJECT_DIR" \
    "caffeinate -i $RUN_CMD; echo ''; echo 'Census finished. Press any key to close.'; read"
elif command -v termux-wake-lock >/dev/null 2>&1; then
  echo "Launching BPCL census (concurrency=$CONCURRENCY) in tmux session 'bpcl-census' (termux-wake-lock)..."
  tmux new-session -d -s bpcl-census -c "$PROJECT_DIR" \
    "termux-wake-lock; $RUN_CMD; termux-wake-unlock; echo ''; echo 'Census finished. Press any key to close.'; read"
else
  echo "WARNING: no caffeinate or termux-wake-lock found — running WITHOUT a wake lock."
  echo "  On Termux: pkg install termux-api"
  tmux new-session -d -s bpcl-census -c "$PROJECT_DIR" \
    "$RUN_CMD; echo ''; echo 'Census finished. Press any key to close.'; read"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Session 'bpcl-census' is running"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Watch live:     tmux attach -t bpcl-census"
echo "  Quick progress: cat $OUTPUT_DIR/bpcl-progress.txt"
echo "  Outlets done:   wc -l $OUTPUT_DIR/bpcl-raw.jsonl"
echo "  Kill it:        tmux kill-session -t bpcl-census"
echo ""
echo "  Detach from tmux: Ctrl+B then D"
echo "  If interrupted: re-run this script — it resumes automatically."
echo ""
