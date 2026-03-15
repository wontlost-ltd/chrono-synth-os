#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_ROOT="${CHRONO_BACKUP_DIR:-$PROJECT_ROOT/backups}"
DB_DRIVER="${CHRONO_DB_DRIVER:-sqlite}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_ROOT/db"

info() {
  printf '[backup_db] %s\n' "$1"
}

prune_old_backups() {
  find "$BACKUP_ROOT/db" -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
}

backup_sqlite() {
  local db_path="${CHRONO_DB_PATH:-$PROJECT_ROOT/data/chrono.db}"
  local output_file="$BACKUP_ROOT/db/chrono-sqlite-${TIMESTAMP}.db"

  if [ ! -f "$db_path" ]; then
    printf 'SQLite database not found: %s\n' "$db_path" >&2
    exit 1
  fi

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db_path" ".backup '$output_file'"
  else
    cp "$db_path" "$output_file"
  fi
  gzip -f "$output_file"
  info "SQLite backup written to ${output_file}.gz"
}

backup_postgres() {
  local conn="${CHRONO_DB_CONNECTION_STRING:-}"
  local output_file="$BACKUP_ROOT/db/chrono-postgres-${TIMESTAMP}.sql.gz"

  if [ -z "$conn" ]; then
    printf 'CHRONO_DB_CONNECTION_STRING is required for postgres backup\n' >&2
    exit 1
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    printf 'pg_dump is required for postgres backup\n' >&2
    exit 1
  fi

  pg_dump "$conn" | gzip -c > "$output_file"
  info "PostgreSQL backup written to $output_file"
}

case "$DB_DRIVER" in
  sqlite)
    backup_sqlite
    ;;
  postgres)
    backup_postgres
    ;;
  *)
    printf 'Unsupported CHRONO_DB_DRIVER: %s\n' "$DB_DRIVER" >&2
    exit 1
    ;;
esac

prune_old_backups
