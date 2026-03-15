#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  printf 'Usage: %s <backup-file>\n' "$0" >&2
  exit 1
fi

INPUT_FILE="$1"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_DRIVER="${CHRONO_DB_DRIVER:-sqlite}"

if [ ! -f "$INPUT_FILE" ]; then
  printf 'Backup file not found: %s\n' "$INPUT_FILE" >&2
  exit 1
fi

info() {
  printf '[restore_db] %s\n' "$1"
}

restore_sqlite() {
  local db_path="${CHRONO_DB_PATH:-$PROJECT_ROOT/data/chrono.db}"
  mkdir -p "$(dirname "$db_path")"

  if [[ "$INPUT_FILE" == *.gz ]]; then
    gunzip -c "$INPUT_FILE" > "$db_path"
  else
    cp "$INPUT_FILE" "$db_path"
  fi
  info "SQLite database restored to $db_path"
}

restore_postgres() {
  local conn="${CHRONO_DB_CONNECTION_STRING:-}"
  if [ -z "$conn" ]; then
    printf 'CHRONO_DB_CONNECTION_STRING is required for postgres restore\n' >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    printf 'psql is required for postgres restore\n' >&2
    exit 1
  fi

  if [[ "$INPUT_FILE" == *.gz ]]; then
    gunzip -c "$INPUT_FILE" | psql "$conn"
  else
    psql "$conn" < "$INPUT_FILE"
  fi
  info "PostgreSQL restore completed"
}

case "$DB_DRIVER" in
  sqlite)
    restore_sqlite
    ;;
  postgres)
    restore_postgres
    ;;
  *)
    printf 'Unsupported CHRONO_DB_DRIVER: %s\n' "$DB_DRIVER" >&2
    exit 1
    ;;
esac
