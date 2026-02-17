/**
 * 价值存储：管理核心价值权重的持久化读写
 */

import type { IDatabase } from '../storage/database.js';
import type { CoreValue, ValueId } from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

interface ValueRow {
  id: string;
  label: string;
  weight: number;
  updated_at: number;
}

export class ValueStore {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 创建新价值维度 */
  create(label: string, weight: number): CoreValue {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError(`价值权重必须在 0-1 之间，收到 ${weight}`);
    const id = generatePrefixedId('val');
    const now = this.clock.now();
    this.db.prepare<void>(
      'INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)',
    ).run(id, label, weight, now);
    return { id, label, weight, updatedAt: now };
  }

  /** 更新价值权重 */
  updateWeight(id: ValueId, weight: number): CoreValue | undefined {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError(`价值权重必须在 0-1 之间，收到 ${weight}`);
    const now = this.clock.now();
    const result = this.db.prepare<void>(
      'UPDATE core_values SET weight = ?, updated_at = ? WHERE id = ?',
    ).run(weight, now, id);
    if (result.changes === 0) return undefined;
    return this.getById(id);
  }

  /** 按 ID 获取 */
  getById(id: ValueId): CoreValue | undefined {
    const row = this.db.prepare<ValueRow>(
      'SELECT id, label, weight, updated_at FROM core_values WHERE id = ?',
    ).get(id);
    return row ? this.toValue(row) : undefined;
  }

  /** 获取全部价值 */
  getAll(): Map<ValueId, CoreValue> {
    const rows = this.db.prepare<ValueRow>(
      'SELECT id, label, weight, updated_at FROM core_values',
    ).all();
    const map = new Map<ValueId, CoreValue>();
    for (const row of rows) {
      map.set(row.id, this.toValue(row));
    }
    return map;
  }

  /** 删除价值 */
  delete(id: ValueId): boolean {
    const result = this.db.prepare<void>(
      'DELETE FROM core_values WHERE id = ?',
    ).run(id);
    return result.changes > 0;
  }

  /** 删除全部价值 */
  deleteAll(): void {
    this.db.exec('DELETE FROM core_values');
  }

  /** 按原始数据插入（恢复用，保留原 ID） */
  insert(value: CoreValue): void {
    this.db.prepare<void>(
      `INSERT INTO core_values (id, label, weight, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, weight=excluded.weight, updated_at=excluded.updated_at`,
    ).run(value.id, value.label, value.weight, value.updatedAt);
  }

  private toValue(row: ValueRow): CoreValue {
    return {
      id: row.id,
      label: row.label,
      weight: row.weight,
      updatedAt: row.updated_at,
    };
  }
}
