#!/bin/bash
# KIVO Batch Vectorize — generate BGE embeddings for entries missing them.
#
# Designed for cron execution at 03:15 daily.
# Calls `kivo embed-backfill` with conservative batch settings to avoid
# BGE timeouts during off-peak hours.
#
# Registered in crontab: 15 3 * * *

set -euo pipefail

KIVO_DIR="/root/.openclaw/workspace/projects/kivo"
LOG_DIR="/root/.openclaw/workspace/logs"
LOG_FILE="${LOG_DIR}/kivo-batch-vectorize.log"

mkdir -p "$LOG_DIR"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

  cd "$KIVO_DIR"

  # Use batch size 10 with 2s sleep between batches to avoid BGE overload
  node dist/esm/cli/index.js embed-backfill --batch-size 10 --sleep-ms 2000 2>&1 || {
    echo "ERROR: embed-backfill failed with exit code $?"
  }

  echo "--- done ---"
  echo ""
} >> "$LOG_FILE" 2>&1
