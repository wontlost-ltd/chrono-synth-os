/**
 * 感知媒体引用 SQL 执行器（ADR-0052 Edge-P5）。
 *
 * 只存对象存储引用元数据（原始媒体绝不进库）。全部 tenant scoped（GDPR/隔离）。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  PerceptionMediaRefRow, MediaRefByIdParams, MediaRefInsertParams, MediaRefSetStatusParams,
} from '@chrono/kernel';
import {
  MEDIA_REF_QUERY_BY_ID, MEDIA_REF_QUERY_BY_TENANT, MEDIA_REF_QUERY_EXPIRED,
  MEDIA_REF_CMD_INSERT, MEDIA_REF_CMD_SET_STATUS, MEDIA_REF_CMD_DELETE,
} from '@chrono/kernel';

export function registerPerceptionMediaExecutors(): void {
  /* ── Queries ── */

  registerQuery<PerceptionMediaRefRow | null, MediaRefByIdParams>(MEDIA_REF_QUERY_BY_ID, (db, p) => {
    return db.prepare<PerceptionMediaRefRow>(
      'SELECT * FROM perception_media_refs WHERE id = ? AND tenant_id = ?',
    ).get(p.id, p.tenantId) ?? null;
  });

  registerQuery<PerceptionMediaRefRow[], string>(MEDIA_REF_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<PerceptionMediaRefRow>(
      'SELECT * FROM perception_media_refs WHERE tenant_id = ? ORDER BY created_at DESC',
    ).all(tenantId);
  });

  /* 过期清理：delete_after 非 NULL 且 ≤ now（retention worker 全局清理，按时间删非租户数据访问）。 */
  registerQuery<PerceptionMediaRefRow[], number>(MEDIA_REF_QUERY_EXPIRED, (db, now) => {
    return db.prepare<PerceptionMediaRefRow>(
      'SELECT * FROM perception_media_refs WHERE delete_after IS NOT NULL AND delete_after <= ?',
    ).all(now);
  });

  /* ── Commands ── */

  registerCommand<MediaRefInsertParams>(MEDIA_REF_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO perception_media_refs
        (id, tenant_id, object_key, sha256, mime, size_bytes, duration_ms, retention_class, delete_after, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.objectKey, p.sha256, p.mime, p.sizeBytes, p.durationMs, p.retentionClass, p.deleteAfter, p.status, p.createdAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<MediaRefSetStatusParams>(MEDIA_REF_CMD_SET_STATUS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE perception_media_refs SET status = ? WHERE id = ? AND tenant_id = ?',
    ).run(p.status, p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MediaRefByIdParams>(MEDIA_REF_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM perception_media_refs WHERE id = ? AND tenant_id = ?',
    ).run(p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
