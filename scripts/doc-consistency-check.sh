#!/usr/bin/env bash
# doc-consistency-check.sh — FR-Z09 文档一致性门禁
# 检查文档中引用的 CLI 命令、API 路径、配置字段是否在代码中存在
# 用法: bash scripts/doc-consistency-check.sh
# 退出码: 0=全部通过, 1=有失败

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
REPORT=""

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  REPORT+="  [PASS] $1\n"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  REPORT+="  [FAIL] $1\n"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  REPORT+="  [WARN] $1\n"
}

# ─── Check 1: README CLI commands exist in package.json bin ───

REPORT+="\n=== 1. README CLI 命令 vs package.json bin ===\n"

# Extract bin entries from package.json
BIN_NAME=$(node -e "const p=require('$PROJECT_DIR/package.json'); console.log(Object.keys(p.bin||{}).join(' '))" 2>/dev/null || echo "")

if [ -z "$BIN_NAME" ]; then
  fail "package.json 中没有 bin 字段"
else
  # Check that README references the correct binary name
  if grep -q "npx $BIN_NAME" "$PROJECT_DIR/README.md"; then
    pass "README 引用的 CLI 命令 'npx $BIN_NAME' 在 package.json bin 中存在"
  else
    fail "README 中未找到 'npx $BIN_NAME' 命令引用"
  fi
fi

# Extract CLI subcommands from src/cli/index.ts
CLI_INDEX="$PROJECT_DIR/src/cli/index.ts"
if [ -f "$CLI_INDEX" ]; then
  # Parse case statements to get subcommands
  CLI_COMMANDS=$(grep -oP "case\s+'(\w[\w-]*)'" "$CLI_INDEX" | sed "s/case '//;s/'//g" | sort -u)

  for cmd in $CLI_COMMANDS; do
    if grep -q "kivo $cmd" "$PROJECT_DIR/README.md"; then
      pass "CLI 子命令 'kivo $cmd' 在 README 中有文档"
    else
      warn "CLI 子命令 'kivo $cmd' 在 README 中未提及"
    fi
  done
else
  fail "src/cli/index.ts 不存在"
fi

# ─── Check 2: quick-start.md API paths vs web/app/api/ ───

REPORT+="\n=== 2. quick-start.md API 路径 vs web/app/api/ ===\n"

QUICK_START="$PROJECT_DIR/docs/quick-start.md"
WEB_API_DIR="$PROJECT_DIR/web/app/api"

if [ ! -f "$QUICK_START" ]; then
  fail "docs/quick-start.md 不存在"
elif [ ! -d "$WEB_API_DIR" ]; then
  fail "web/app/api/ 目录不存在"
else
  # Extract API paths mentioned in quick-start.md (patterns like /api/... or /kivo/...)
  API_PATHS=$(grep -oP '(?<=/)(api/v1/[\w/]+|api/auth/[\w/]+)' "$QUICK_START" | sort -u || true)

  if [ -z "$API_PATHS" ]; then
    # quick-start.md references page routes, not API routes directly — check page routes
    PAGE_PATHS=$(grep -oP '/kivo/(\w+)' "$QUICK_START" | sort -u || true)
    if [ -n "$PAGE_PATHS" ]; then
      for path in $PAGE_PATHS; do
        # Strip /kivo/ prefix to get page name
        page=$(echo "$path" | sed 's|/kivo/||')
        if [ -d "$PROJECT_DIR/web/app/kivo/$page" ] || [ -f "$PROJECT_DIR/web/app/kivo/$page/page.tsx" ]; then
          pass "页面路由 $path 在 web/app/ 中存在"
        else
          # Check alternative locations
          if find "$PROJECT_DIR/web/app" -path "*/$page*" -name "page.tsx" 2>/dev/null | head -1 | grep -q .; then
            pass "页面路由 $path 在 web/app/ 中存在（子目录）"
          else
            warn "页面路由 $path 在 web/app/ 中未找到对应 page.tsx"
          fi
        fi
      done
    else
      pass "quick-start.md 未直接引用 API 路径（通过 SDK 调用）"
    fi
  else
    for api_path in $API_PATHS; do
      # Convert api path to filesystem path
      fs_path="$WEB_API_DIR/${api_path#api/}"
      if [ -d "$fs_path" ] || [ -f "$fs_path/route.ts" ]; then
        pass "API 路径 /$api_path 在 web/app/api/ 中存在"
      else
        fail "API 路径 /$api_path 在 web/app/api/ 中不存在"
      fi
    done
  fi

  # Also check that documented API routes actually exist
  REPORT+="\n=== 2b. web/app/api/ 路由完整性 ===\n"
  ROUTE_FILES=$(find "$WEB_API_DIR" -name "route.ts" 2>/dev/null | sort)
  ROUTE_COUNT=$(echo "$ROUTE_FILES" | grep -c "route.ts" || echo 0)
  pass "web/app/api/ 下共有 $ROUTE_COUNT 个 API 路由文件"
fi

# ─── Check 3: configuration-reference.md config fields vs src/config/ ───

REPORT+="\n=== 3. configuration-reference.md 配置字段 vs src/config/ ===\n"

CONFIG_REF="$PROJECT_DIR/docs/configuration-reference.md"
CONFIG_TYPES="$PROJECT_DIR/src/config/types.ts"
ENV_LOADER="$PROJECT_DIR/src/config/env-loader.ts"

if [ ! -f "$CONFIG_REF" ]; then
  fail "docs/configuration-reference.md 不存在"
else
  # Check documented config fields exist in types.ts
  DOC_FIELDS=$(grep -oP '### `(\w[\w.]*)`' "$CONFIG_REF" | sed "s/### \`//;s/\`//" | sort -u)

  for field in $DOC_FIELDS; do
    # Top-level field name (before first dot)
    top_field=$(echo "$field" | cut -d. -f1)

    # AUTH_PASSWORD is a Web-only env var, not a kivo.config.json field
    if [ "$top_field" = "AUTH_PASSWORD" ]; then
      pass "配置字段 '$field' 是 Web 专用环境变量（不在 kivo.config.json 中）"
      continue
    fi

    if grep -q "$top_field" "$CONFIG_TYPES" 2>/dev/null; then
      pass "配置字段 '$field' 在 src/config/types.ts 中有定义"
    elif grep -q "$top_field" "$ENV_LOADER" 2>/dev/null; then
      pass "配置字段 '$field' 在 src/config/env-loader.ts 中有处理"
    else
      fail "配置字段 '$field' 在 src/config/ 中未找到定义"
    fi
  done

  # Check documented env vars exist in env-loader.ts
  DOC_ENVS=$(grep -oP '### `(KIVO_\w+|AUTH_\w+)`' "$CONFIG_REF" | sed "s/### \`//;s/\`//" | sort -u)

  for env_var in $DOC_ENVS; do
    if grep -q "$env_var" "$ENV_LOADER" 2>/dev/null; then
      pass "环境变量 $env_var 在 env-loader.ts 中有映射"
    elif [ "$env_var" = "AUTH_PASSWORD" ]; then
      # AUTH_PASSWORD is used in web auth, not in env-loader
      if find "$PROJECT_DIR/web" -name "*.ts" -exec grep -l "AUTH_PASSWORD" {} \; 2>/dev/null | head -1 | grep -q .; then
        pass "环境变量 $env_var 在 web/ 认证代码中使用"
      else
        warn "环境变量 $env_var 未在代码中找到引用"
      fi
    else
      fail "环境变量 $env_var 在 env-loader.ts 中无映射"
    fi
  done

  # Reverse check: env vars in code but not documented
  CODE_ENVS=$(grep -oP "KIVO_\w+" "$ENV_LOADER" 2>/dev/null | sort -u)
  for env_var in $CODE_ENVS; do
    if ! grep -q "$env_var" "$CONFIG_REF" 2>/dev/null; then
      warn "代码中的环境变量 $env_var 在 configuration-reference.md 中未文档化"
    fi
  done
fi

# ─── Check 4: Cross-doc link integrity ───

REPORT+="\n=== 4. 文档间链接完整性 ===\n"

README="$PROJECT_DIR/README.md"
DOCS_DIR="$PROJECT_DIR/docs"

# Check README links to docs/
README_LINKS=$(grep -oP '\./docs/[\w/.-]+\.md' "$README" | sort -u || true)
for link in $README_LINKS; do
  target="$PROJECT_DIR/$link"
  if [ -f "$target" ]; then
    pass "README 链接 $link 目标文件存在"
  else
    fail "README 链接 $link 目标文件不存在"
  fi
done

# Check cross-references within docs/
for doc in "$DOCS_DIR"/*.md; do
  [ -f "$doc" ] || continue
  basename=$(basename "$doc")
  refs=$(grep -oP '[\w-]+\.md' "$doc" | sort -u || true)
  for ref in $refs; do
    if [ "$ref" = "$basename" ]; then continue; fi
    if [ -f "$DOCS_DIR/$ref" ] || [ -f "$PROJECT_DIR/$ref" ]; then
      pass "$basename 引用的 $ref 存在"
    else
      warn "$basename 引用的 $ref 未找到"
    fi
  done
done

# ─── Check 5: Required docs exist ───

REPORT+="\n=== 5. 必需文档存在性 ===\n"

REQUIRED_DOCS=(
  "README.md"
  "docs/quick-start.md"
  "docs/configuration-reference.md"
  "docs/troubleshooting.md"
  "docs/upgrade-guide.md"
)

for doc in "${REQUIRED_DOCS[@]}"; do
  if [ -f "$PROJECT_DIR/$doc" ]; then
    line_count=$(wc -l < "$PROJECT_DIR/$doc")
    if [ "$line_count" -gt 10 ]; then
      pass "$doc 存在（${line_count} 行）"
    else
      warn "$doc 存在但内容过少（${line_count} 行）"
    fi
  else
    fail "$doc 不存在"
  fi
done

# ─── Summary ───

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   KIVO 文档一致性检查报告 (FR-Z09)      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo -e "$REPORT"
echo "─────────────────────────────────────────"
echo "  PASS: $PASS_COUNT"
echo "  WARN: $WARN_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo "─────────────────────────────────────────"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "  结果: FAIL（有 $FAIL_COUNT 项未通过）"
  echo ""
  exit 1
else
  echo "  结果: PASS（全部通过）"
  echo ""
  exit 0
fi
