#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_ROOT="${CHRONO_BACKUP_DIR:-$PROJECT_ROOT/backups}"
STORAGE_PATH="${CHRONO_STORAGE_PATH:-$PROJECT_ROOT/data}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_ROOT/storage"

if [ ! -d "$STORAGE_PATH" ]; then
  printf 'Storage path not found: %s\n' "$STORAGE_PATH" >&2
  exit 1
fi

OUTPUT_FILE="$BACKUP_ROOT/storage/chrono-storage-${TIMESTAMP}.tar.gz"
tar -C "$(dirname "$STORAGE_PATH")" -czf "$OUTPUT_FILE" "$(basename "$STORAGE_PATH")"
find "$BACKUP_ROOT/storage" -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

printf '[backup_storage] Archive written to %s\n' "$OUTPUT_FILE"
