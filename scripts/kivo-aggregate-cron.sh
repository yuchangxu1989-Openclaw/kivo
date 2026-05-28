#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Crontab example:
# 0 3 * * * /root/.openclaw/workspace/projects/kivo/scripts/kivo-aggregate-cron.sh
npx tsx src/cli/index.ts aggregate "$@"
