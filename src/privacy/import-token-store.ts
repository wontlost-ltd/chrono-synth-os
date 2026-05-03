import type { IDatabase } from '../storage/database.js';

export interface ImportTokenStore {
  issue(
    token: string,
    tenantId: string,
    importId: string,
    manifestChecksum: string,
    expiresAt: number,
  ): void;
  consume(
    token: string,
    tenantId: string,
    manifestChecksum: string,
  ): { importId: string } | null;
  pruneExpired(): void;
}

interface ImportCommitTokenRow {
  import_id: string;
}

export function createImportTokenStore(db: IDatabase): ImportTokenStore {
  return {
    issue(token, tenantId, importId, manifestChecksum, expiresAt) {
      db.prepare<void>(
        `INSERT INTO import_commit_tokens
           (token, tenant_id, import_id, manifest_checksum, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(token, tenantId, importId, manifestChecksum, expiresAt, Date.now());
    },

    consume(token, tenantId, manifestChecksum) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare<ImportCommitTokenRow>(
          `SELECT import_id
             FROM import_commit_tokens
            WHERE token = ?
              AND tenant_id = ?
              AND manifest_checksum = ?
              AND expires_at > ?`,
        ).get(token, tenantId, manifestChecksum, Date.now());

        if (!row) {
          db.exec('COMMIT');
          return null;
        }

        const result = db.prepare<void>(
          `DELETE FROM import_commit_tokens
            WHERE token = ?
              AND tenant_id = ?
              AND manifest_checksum = ?`,
        ).run(token, tenantId, manifestChecksum);

        if (result.changes !== 1) {
          db.exec('ROLLBACK');
          return null;
        }

        db.exec('COMMIT');
        return { importId: row.import_id };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },

    pruneExpired() {
      db.prepare<void>(
        'DELETE FROM import_commit_tokens WHERE expires_at <= ?',
      ).run(Date.now());
    },
  };
}
