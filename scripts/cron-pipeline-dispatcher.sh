#!/usr/bin/env bash
#
# FR-A02 Pipeline Dispatcher Cron — KIVO
#
# 每 5 分钟由 crontab 调用一次。职责：
#   1) 读 web/.env.local 取 KIVO_INTERNAL_TOKEN
#   2) 调 POST http://127.0.0.1:3721/kivo/api/internal/dispatcher/tick
#      触发 web 端 dispatcher，扫描 task_queue + backfill classified materials
#      → process_pipeline / classify_pending 任务并发执行
#   3) HTTP 非 200 / 鉴权失败 → 记 stderr 由 cron 捕获到日志，退出码非零
#
# 故意不直接调 sqlite / lib：dispatchTick 已经在 web 进程里维持
# better-sqlite3 句柄、LLM 客户端、pdfjs 等单例，绕开 web 自己跑会
# 引入双写句柄风险。
#
# 失败可恢复策略：
#   - kivo-web 没启动：curl 超时退出 7（连接拒绝）；下个 tick 自然恢复
#   - INTERNAL_TOKEN 缺失：直接退出 1，cron 日志里能看到
#
# OpenCode (OpenClaw ACP Agent) / 2026-05-24

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

# Read KIVO_INTERNAL_TOKEN from env file (without sourcing the file
# so we don't accidentally execute arbitrary content).
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
  -d "{\"concurrency\":$CONCURRENCY}" || echo "000")"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[$TS] tick http=$HTTP_CODE body=$(head -c 400 "$RESPONSE_FILE")" >&2
  exit 1
fi

# Compact one-line summary to keep the log small. Falls back to the raw
# body if jq isn't installed.
if command -v jq >/dev/null 2>&1; then
  jq -c '{ts: "'"$TS"'", tick: .tickId, dispatched: .dispatched, succeeded: .succeeded, failed: .failed, ms: .durationMs}' "$RESPONSE_FILE"
else
  echo "[$TS] $(cat "$RESPONSE_FILE")"
fi
