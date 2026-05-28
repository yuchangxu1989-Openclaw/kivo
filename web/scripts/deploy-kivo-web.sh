#!/bin/bash
set -e

KIVO_WEB_DIR="/root/.openclaw/workspace/projects/kivo/web"
PORT=3721
LOG_FILE="/tmp/kivo-web.log"
: "${AUTH_PASSWORD:?AUTH_PASSWORD must be set before deploy}"

echo "[deploy] Starting KIVO Web deployment..."

# 1. 强制 clean build（每次都删 .next，杜绝缓存损坏）
cd "$KIVO_WEB_DIR"
echo "[deploy] Cleaning .next cache..."
rm -rf .next

echo "[deploy] Building..."
NODE_OPTIONS="--max-old-space-size=3072" npm run build
if [ $? -ne 0 ]; then
  echo "[deploy] Build FAILED. Aborting deployment."
  exit 1
fi

# 2. 验证 build 产物完整性
if [ ! -d ".next/server" ] || [ ! -d ".next/static" ]; then
  echo "[deploy] Build output incomplete. Aborting."
  exit 1
fi

# 3. 停旧进程（kill 所有占用端口的进程）
echo "[deploy] Stopping all processes on port ${PORT}..."
PORT_PIDS=$(lsof -ti:${PORT} 2>/dev/null || true)
if [ -n "$PORT_PIDS" ]; then
  echo "[deploy] Killing PIDs: $PORT_PIDS"
  echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
fi

# 3.1 等待端口释放
echo "[deploy] Waiting for port ${PORT} to be released..."
for i in $(seq 1 30); do
  if ! lsof -ti:${PORT} >/dev/null 2>&1; then
    echo "[deploy] Port ${PORT} is free."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[deploy] FAILED: Port ${PORT} still occupied after 30s"
    exit 1
  fi
  sleep 1
done

# 3.2 记录 BUILD_ID 用于启动后验证
BUILD_ID=$(cat "${KIVO_WEB_DIR}/.next/BUILD_ID" 2>/dev/null || echo "")
if [ -z "$BUILD_ID" ]; then
  echo "[deploy] WARNING: No BUILD_ID found in .next/BUILD_ID"
else
  echo "[deploy] Expected BUILD_ID: $BUILD_ID"
fi

# 4. 启动前再次确认端口空闲
if lsof -ti:${PORT} >/dev/null 2>&1; then
  echo "[deploy] FAILED: Port ${PORT} unexpectedly occupied before start"
  exit 1
fi

# 5. 启动新进程
echo "[deploy] Starting on port ${PORT}..."
export AUTH_PASSWORD
nohup npx next start -p "$PORT" > "$LOG_FILE" 2>&1 &
NEW_PID=$!

# 6. 等待启动 + 健康检查
echo "[deploy] Waiting for startup..."
HTTP_CODE="000"
for i in $(seq 1 15); do
  sleep 2
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/kivo/login" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    break
  fi
  echo "[deploy] Attempt $i: HTTP $HTTP_CODE"
done

if [ "$HTTP_CODE" != "200" ]; then
  echo "[deploy] FAILED: Service not responding after 30s"
  exit 1
fi

# 6.1 验证 buildId 一致性
if [ -n "$BUILD_ID" ]; then
  echo "[deploy] Verifying BUILD_ID consistency..."
  PAGE_HTML=$(curl -s "http://localhost:${PORT}/kivo/login" 2>/dev/null)
  if echo "$PAGE_HTML" | grep -q "$BUILD_ID"; then
    echo "[deploy] BUILD_ID verified: $BUILD_ID matches running process"
  else
    echo "[deploy] FAILED: BUILD_ID mismatch! .next/BUILD_ID=$BUILD_ID but running process serves different build"
    echo "[deploy] This means an old process may still be serving. Aborting."
    kill -9 $NEW_PID 2>/dev/null || true
    exit 1
  fi
fi

# 7. 登录测试
LOGIN_RESULT=$(curl -s -c /tmp/kivo-deploy-test.txt -X POST "http://localhost:${PORT}/kivo/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${AUTH_PASSWORD}\",\"identity\":\"phoenix\"}" 2>/dev/null)
LOGIN_OK=$(echo "$LOGIN_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null)

if [ "$LOGIN_OK" != "True" ]; then
  echo "[deploy] FAILED: Login test failed"
  echo "[deploy] Response: $LOGIN_RESULT"
  exit 1
fi

# 8. Dashboard 页面检查（确认无 Application error）
DASH_ERRORS=$(curl -s -b /tmp/kivo-deploy-test.txt "http://localhost:${PORT}/kivo/dashboard" 2>/dev/null | grep -c "Application error" || true)
if [ "$DASH_ERRORS" != "0" ]; then
  echo "[deploy] FAILED: Dashboard has Application error"
  exit 1
fi

# 9. 检查服务端日志无 clientModules 错误
sleep 2
CM_ERRORS=$(grep -c "clientModules" "$LOG_FILE" 2>/dev/null || echo "0")
if [ "$CM_ERRORS" != "0" ]; then
  echo "[deploy] WARNING: clientModules errors detected in log"
fi

echo "[deploy] SUCCESS: KIVO Web deployed and verified"
echo "[deploy] PID: $NEW_PID"
echo "[deploy] BUILD_ID: $BUILD_ID"
echo "[deploy] URL: http://localhost:${PORT}/kivo/login"

rm -f /tmp/kivo-deploy-test.txt
