/**
 * 快照存储：持久化和恢复系统完整状态快照
 */

import type { IDatabase } from '../storage/database.js';
import { deepStringify, deepParse } from '../storage/serialization.js';
import type { SystemSnapshot, SnapshotId } from '../types/snapshot.js';

interface SnapshotRow {
  id: string;
  data_json: string;
  reason: string;
  created_at: number;
}

export class SnapshotStore {
  constructor(private readonly db: IDatabase) {}

  /** 保存快照 */
  save(snapshot: SystemSnapshot): void {
    this.db.prepare<void>(
      'INSERT INTO snapshots (id, data_json, reason, created_at) VALUES (?, ?, ?, ?)',
    ).run(snapshot.id, deepStringify(snapshot), snapshot.reason, snapshot.createdAt);
  }

  /** 按 ID 加载快照 */
  load(id: SnapshotId): SystemSnapshot | undefined {
    const row = this.db.prepare<SnapshotRow>(
      'SELECT * FROM snapshots WHERE id = ?',
    ).get(id);
    if (!row) return undefined;
    return deepParse<SystemSnapshot>(row.data_json) ?? undefined;
  }

  /** 获取最新快照 */
  getLatest(): SystemSnapshot | undefined {
    const row = this.db.prepare<SnapshotRow>(
      'SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1',
    ).get();
    if (!row) return undefined;
    return deepParse<SystemSnapshot>(row.data_json) ?? undefined;
  }

  /** 列出所有快照的元数据 */
  list(): Array<{ id: string; reason: string; createdAt: number }> {
    const rows = this.db.prepare<SnapshotRow>(
      'SELECT id, reason, created_at FROM snapshots ORDER BY created_at DESC',
    ).all();
    return rows.map(r => ({ id: r.id, reason: r.reason, createdAt: r.created_at }));
  }

  /** 删除快照 */
  delete(id: SnapshotId): boolean {
    const result = this.db.prepare<void>('DELETE FROM snapshots WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
