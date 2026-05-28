#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="$ROOT_DIR/.build-lock"
LOCK_FILE="$LOCK_DIR/kivo-web-next-build.lock"
TMP_DIST_DIR=".next-stage"
TMP_DIST_PATH="$ROOT_DIR/$TMP_DIST_DIR"
FINAL_DIST_PATH="$ROOT_DIR/.next"
BACKUP_DIST_PATH="$ROOT_DIR/.next.previous"

mkdir -p "$LOCK_DIR"

cleanup() {
  rm -rf "$TMP_DIST_PATH"
}

trap cleanup EXIT

exec 9>"$LOCK_FILE"
flock 9

cd "$ROOT_DIR"

rm -rf "$TMP_DIST_PATH"
KIVO_NEXT_DIST_DIR="$TMP_DIST_DIR" npx next build

rm -rf "$BACKUP_DIST_PATH"
if [ -d "$FINAL_DIST_PATH" ]; then
  mv "$FINAL_DIST_PATH" "$BACKUP_DIST_PATH"
fi
mv "$TMP_DIST_PATH" "$FINAL_DIST_PATH"
rm -rf "$BACKUP_DIST_PATH"
