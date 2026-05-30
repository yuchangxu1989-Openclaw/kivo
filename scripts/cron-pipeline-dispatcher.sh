#!/usr/bin/env bash
# FR-A02 Pipeline Dispatcher Cron — KIVO
# Central dispatcher heartbeat for task_queue and classified material backfill.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/web/.env.local"
ENDPOINT="${KIVO_DISPATCHER_ENDPOINT:-http://127.0.0.1:3721/kivo/api/internal/dispatcher/tick}"
CONCURRENCY="${KIVO_DISPATCHER_CONCURRENCY:-3}"
TIMEOUT_SECONDS="${KIVO_DISPATCHER_TIMEOUT_SECONDS:-300}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[$(date -Iseconds)] ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

TOKEN="$(grep -E '^KIVO_INTERNAL_TOKEN=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
if [[ -z "$TOKEN" ]]; then
  echo "[$(date -Iseconds)] ERROR: KIVO_INTERNAL_TOKEN missing in $ENV_FILE" >&2
  exit 1
fi

TS="$(date -Iseconds)"
RESPONSE_FILE="$(mktemp -t kivo-tick-XXXXXX.json)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  --max-time "$TIMEOUT_SECONDS" \
  -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"concurrency\":$CONCURRENCY,\"includeBackfill\":true}" || echo "000")"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[$TS] tick http=$HTTP_CODE body=$(head -c 400 "$RESPONSE_FILE")" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  jq -c '{ts: "'"$TS"'", tick: .tickId, dispatched: .dispatched, succeeded: .succeeded, failed: .failed, backfill: (.backfill // .materials // null), ms: .durationMs}' "$RESPONSE_FILE"
else
  echo "[$TS] $(cat "$RESPONSE_FILE")"
fi
