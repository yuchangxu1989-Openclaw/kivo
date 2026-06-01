#!/bin/bash
# KIVO 3-day session knowledge rebuild — resume script
#
# Context: kivo.db was reset to an empty 0-byte file on 2026-06-01.
# This script extracts knowledge from the 3 named .reset session files
# (2026-05-29 ~ 2026-05-30) into the fresh DB using KIVO's own tooling.
#
# HARD DEPENDENCY: the penguin LLM endpoint (api.penguinsaichat.dpdns.org)
# must be reachable. KIVO has NO offline extraction fallback by design
# (see .claude/rules/kivo-sevo-constraints.md + admission gate LOCK).
#
# Run:  bash projects/kivo/scripts/rebuild-from-3day-sessions.sh
set -uo pipefail

WS=/root/.openclaw/workspace
KIVO=$WS/projects/kivo
SRC=/root/.openclaw/agents/main/sessions
TMP=/tmp/kivo-3day-src
LOG=/tmp/kivo-rebuild.txt

FILES=(
  d771f1fc-e9a2-43d0-b87e-75eab920a75b.jsonl.reset.2026-05-29T00-12-23.304Z
  35a98c3e-e402-4e59-a89d-bbbd4acc7104.jsonl.reset.2026-05-29T22-12-42.793Z
  70473931-9374-482f-89ef-68adf65529aa.jsonl.reset.2026-05-30T23-01-55.813Z
)

exec >>"$LOG" 2>&1
echo ""
echo "############ RESUME REBUILD $(date '+%F %T') ############"

# 0. Preflight: penguin LLM endpoint must answer (no fallback by design)
KEY=$(python3 -c "import json;print(json.load(open('/root/.openclaw/openclaw.json'))['models']['providers']['penguin-hermes']['apiKey'])")
CODE=$(curl -s -m 25 -o /tmp/penguin-probe.txt -w "%{http_code}" \
  -X POST "https://api.penguinsaichat.dpdns.org/v1/chat/completions" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"reply OK"}],"max_tokens":10,"temperature":0}')
echo "[preflight] penguin HTTP=$CODE"
if [ "$CODE" != "200" ]; then
  echo "[preflight] BLOCKED: LLM endpoint not 200 (got $CODE). Body:"; head -c 400 /tmp/penguin-probe.txt
  echo; echo "Aborting — KIVO extraction has no offline fallback."; exit 1
fi

# 1. Scope to exactly the 3 named files (avoid sweeping live sessions)
rm -rf "$TMP"; mkdir -p "$TMP"
for f in "${FILES[@]}"; do ln -s "$SRC/$f" "$TMP/$f"; done
echo "[scope] linked ${#FILES[@]} session files into $TMP"

# 2. Preprocessor: extract → segment → filter → BGE cluster → LLM admission gate
cd "$WS"
python3 scripts/session-knowledge-extractor.py --sessions-dir "$TMP"
PP=$?
echo "[preprocessor] exit=$PP"
[ $PP -ne 0 ] && { echo "[preprocessor] FAILED — see trace above"; exit 1; }

# 3. Node extraction: candidates → LLM knowledge extraction → quality gate → DB
cd "$KIVO"
node dist/esm/cli/index.js extract-sessions \
  --candidates "$WS/reports/session-knowledge-candidates.json"
EX=$?
echo "[extract-sessions] exit=$EX"

# 4. Verify
echo "[verify] entries count:"
sqlite3 "$KIVO/kivo.db" "SELECT count(*) FROM entries;"
echo "[verify] processed_sessions:"
sqlite3 "$KIVO/kivo.db" "SELECT session_id, processed_at FROM processed_sessions;"
echo "############ DONE $(date '+%F %T') ############"
