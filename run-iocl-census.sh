#!/bin/bash
# ──────────────────────────────────────────────────
# IOCL Full National Census — tmux launch script
# ──────────────────────────────────────────────────
# Usage: bash run-iocl-census.sh [CONCURRENCY]
#   CONCURRENCY defaults to 10 — proven safe from a residential IP across
#   39,496 outlets (3.4h). Datacenter IPs (e.g. GH Actions) are a different
#   risk profile — calibrate with a small IOCL_CENSUS_LIMIT first.
#
# ⚠️  locator.iocl.com is WAF-sensitive. Back off immediately if you see
#     sustained httpFailed/errored results — 15/20/30 all tripped blocks;
#     10 is the proven-safe ceiling. See docs/research/iocl-waf-calibration.md
#     in the E0-Finder repo for the full calibration history.
#
# Works on macOS (caffeinate) and Termux/Android (termux-wake-lock). Falls
# back to running unlocked with a warning if neither is available.
#
# Resumable by default — re-running after a crash/sleep picks up where it
# left off. Set IOCL_CENSUS_FRESH=1 to wipe progress and restart from zero.
# ──────────────────────────────────────────────────

set -euo pipefail

CONCURRENCY="${1:-12}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$PROJECT_DIR/output"

if tmux has-session -t iocl-census 2>/dev/null; then
  echo "ERROR: tmux session 'iocl-census' already exists."
  echo "  Attach: tmux attach -t iocl-census"
  echo "  Kill:   tmux kill-session -t iocl-census"
  exit 1
fi

if [ "${IOCL_CENSUS_FRESH:-0}" = "1" ]; then
  echo "IOCL_CENSUS_FRESH=1 — wiping existing progress..."
  rm -f "$OUTPUT_DIR/iocl-worklog.jsonl" \
        "$OUTPUT_DIR/iocl-raw.jsonl" \
        "$OUTPUT_DIR/iocl-progress.txt" \
        "$OUTPUT_DIR/iocl-discovered-urls.json"
elif [ -f "$OUTPUT_DIR/iocl-worklog.jsonl" ] || [ -f "$OUTPUT_DIR/iocl-discovered-urls.json" ]; then
  echo "Existing census progress found — RESUMING."
  echo "  Set IOCL_CENSUS_FRESH=1 to force a full restart instead."
fi

RUN_CMD="env IOCL_CENSUS_CONCURRENCY=$CONCURRENCY npm run census:iocl"

if command -v caffeinate >/dev/null 2>&1; then
  echo "Launching IOCL census (concurrency=$CONCURRENCY) in tmux session 'iocl-census' (caffeinate)..."
  tmux new-session -d -s iocl-census -c "$PROJECT_DIR" \
    "caffeinate -i $RUN_CMD; echo ''; echo 'Census finished. Press any key to close.'; read"
elif command -v termux-wake-lock >/dev/null 2>&1; then
  echo "Launching IOCL census (concurrency=$CONCURRENCY) in tmux session 'iocl-census' (termux-wake-lock)..."
  tmux new-session -d -s iocl-census -c "$PROJECT_DIR" \
    "termux-wake-lock; $RUN_CMD; termux-wake-unlock; echo ''; echo 'Census finished. Press any key to close.'; read"
else
  echo "WARNING: no caffeinate or termux-wake-lock found — running WITHOUT a wake lock."
  echo "  On Termux: pkg install termux-api"
  tmux new-session -d -s iocl-census -c "$PROJECT_DIR" \
    "$RUN_CMD; echo ''; echo 'Census finished. Press any key to close.'; read"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Session 'iocl-census' is running"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Watch live:     tmux attach -t iocl-census"
echo "  Quick progress: cat $OUTPUT_DIR/iocl-progress.txt"
echo "  Outlets done:   wc -l $OUTPUT_DIR/iocl-raw.jsonl"
echo "  Kill it:        tmux kill-session -t iocl-census"
echo ""
echo "  Detach from tmux: Ctrl+B then D"
echo "  If interrupted: re-run this script — it resumes automatically."
echo ""
