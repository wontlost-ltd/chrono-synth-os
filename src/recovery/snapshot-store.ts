/**
 * 快照存储：持久化和恢复系统完整状态快照
 */

import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { snapQueryById, snapQueryLatest, snapQueryList, snapCmdSave, snapCmdDelete } from '@chrono/kernel';
import { deepStringify, deepParse } from '../storage/serialization.js';
import type { SystemSnapshot, SnapshotId } from '../types/snapshot.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export class SnapshotStore {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase) {
    registerCoreSelfExecutors();
    this.tx = db;
  }

  /** 保存快照 */
  save(snapshot: SystemSnapshot): void {
    this.tx.execute(snapCmdSave({
      id: snapshot.id,
      dataJson: deepStringify(snapshot),
      reason: snapshot.reason,
      createdAt: snapshot.createdAt,
    }));
  }

  /** 按 ID 加载快照 */
  load(id: SnapshotId): SystemSnapshot | undefined {
    const row = this.tx.queryOne(snapQueryById(id));
    if (!row) return undefined;
    const parsed = deepParse<SystemSnapshot>(row.data_json);
    if (!parsed) throw new Error(`快照 ${id} JSON 解析失败`);
    return parsed;
  }

  /**
   * 按 ID 读取快照的**原始**行（id + 原始 dataJson 字符串 + reason + createdAt），不解析。
   * 供 desktop 同步：desktop 需要把 data_json 原样落到本地 snapshots 表后本地算 drift（ADR-0046 路线 A）。
   */
  loadRaw(id: SnapshotId): { id: string; dataJson: string; reason: string; createdAt: number } | undefined {
    const row = this.tx.queryOne(snapQueryById(id));
    if (!row) return undefined;
    return { id: row.id, dataJson: row.data_json, reason: row.reason, createdAt: row.created_at };
  }

  /** 获取最新快照 */
  getLatest(): SystemSnapshot | undefined {
    const row = this.tx.queryOne(snapQueryLatest());
    if (!row) return undefined;
    const parsed = deepParse<SystemSnapshot>(row.data_json);
    if (!parsed) throw new Error(`快照 ${row.id} JSON 解析失败`);
    return parsed;
  }

  /** 列出所有快照的元数据 */
  list(): Array<{ id: string; reason: string; createdAt: number }> {
    const rows = [...this.tx.queryMany(snapQueryList())];
    return rows.map(r => ({ id: r.id, reason: r.reason, createdAt: r.created_at }));
  }

  /** 删除快照 */
  delete(id: SnapshotId): boolean {
    const result = this.tx.execute(snapCmdDelete(id));
    return result.rowsAffected > 0;
  }
}
