#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

DB_PATH="$TMP_DIR/data/chrono.db"
BACKUP_DIR="$TMP_DIR/backups"
STORAGE_PATH="$TMP_DIR/storage"

mkdir -p "$(dirname "$DB_PATH")" "$STORAGE_PATH"
printf 'artifact-ok\n' > "$STORAGE_PATH/blob.txt"

DB_PATH="$DB_PATH" node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH);
db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.prepare('INSERT INTO notes (id, value) VALUES (?, ?)').run('note_1', 'backup-ok');
const row = db.prepare('SELECT value FROM notes WHERE id = ?').get('note_1');
assert.equal(row.value, 'backup-ok');
db.close();
EOF

CHRONO_DB_DRIVER=sqlite \
CHRONO_DB_PATH="$DB_PATH" \
CHRONO_BACKUP_DIR="$BACKUP_DIR" \
bash "$PROJECT_ROOT/scripts/backup_db.sh"

SQLITE_BACKUP="$(find "$BACKUP_DIR/db" -type f -name 'chrono-sqlite-*.db.gz' | head -1)"
if [ -z "$SQLITE_BACKUP" ]; then
  printf 'sqlite backup file not found\n' >&2
  exit 1
fi

rm -f "$DB_PATH"

CHRONO_DB_DRIVER=sqlite \
CHRONO_DB_PATH="$DB_PATH" \
bash "$PROJECT_ROOT/scripts/restore_db.sh" "$SQLITE_BACKUP"

DB_PATH="$DB_PATH" node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH);
const row = db.prepare('SELECT value FROM notes WHERE id = ?').get('note_1');
assert.equal(row.value, 'backup-ok');
db.close();
EOF

CHRONO_STORAGE_PATH="$STORAGE_PATH" \
CHRONO_BACKUP_DIR="$BACKUP_DIR" \
bash "$PROJECT_ROOT/scripts/backup_storage.sh"

STORAGE_BACKUP="$(find "$BACKUP_DIR/storage" -type f -name 'chrono-storage-*.tar.gz' | head -1)"
if [ -z "$STORAGE_BACKUP" ]; then
  printf 'storage backup file not found\n' >&2
  exit 1
fi

tar -tzf "$STORAGE_BACKUP" | grep -q 'storage/blob.txt'

printf '[test_disaster_recovery] sqlite backup/restore and storage backup verified\n'
