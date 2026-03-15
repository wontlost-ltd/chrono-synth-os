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
  time_discount: number;
  emotion_amplifier: number;
  updated_at: number;
}

function assertWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new RangeError(`价值权重必须在 0-1 之间，收到 ${weight}`);
  }
}

function assertTimeDiscount(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`时间折扣必须在 0-1 之间，收到 ${value}`);
  }
}

function assertEmotionAmplifier(value: number): void {
  if (!Number.isFinite(value) || value < 0.5 || value > 2.0) {
    throw new RangeError(`情绪放大必须在 0.5-2.0 之间，收到 ${value}`);
  }
}

export class ValueStore {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 创建新价值维度 */
  create(label: string, weight: number, timeDiscount = 0.5, emotionAmplifier = 1.0): CoreValue {
    assertWeight(weight);
    assertTimeDiscount(timeDiscount);
    assertEmotionAmplifier(emotionAmplifier);
    const id = generatePrefixedId('val');
    const now = this.clock.now();
    this.db.prepare<void>(
      'INSERT INTO core_values (id, label, weight, time_discount, emotion_amplifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, label, weight, timeDiscount, emotionAmplifier, now);
    return { id, label, weight, timeDiscount, emotionAmplifier, updatedAt: now };
  }

  /** 更新价值权重（向后兼容） */
  updateWeight(id: ValueId, weight: number): CoreValue | undefined {
    return this.update(id, { weight });
  }

  /** 更新价值参数 */
  update(
    id: ValueId,
    patch: { weight?: number; timeDiscount?: number; emotionAmplifier?: number },
  ): CoreValue | undefined {
    const updates: string[] = [];
    const params: number[] = [];

    if (patch.weight !== undefined) {
      assertWeight(patch.weight);
      updates.push('weight = ?');
      params.push(patch.weight);
    }
    if (patch.timeDiscount !== undefined) {
      assertTimeDiscount(patch.timeDiscount);
      updates.push('time_discount = ?');
      params.push(patch.timeDiscount);
    }
    if (patch.emotionAmplifier !== undefined) {
      assertEmotionAmplifier(patch.emotionAmplifier);
      updates.push('emotion_amplifier = ?');
      params.push(patch.emotionAmplifier);
    }

    if (updates.length === 0) return this.getById(id);

    const now = this.clock.now();
    updates.push('updated_at = ?');
    params.push(now);

    const result = this.db.prepare<void>(
      `UPDATE core_values SET ${updates.join(', ')} WHERE id = ?`,
    ).run(...params, id);
    if (result.changes === 0) return undefined;
    return this.getById(id);
  }

  /** 按 ID 获取 */
  getById(id: ValueId): CoreValue | undefined {
    const row = this.db.prepare<ValueRow>(
      'SELECT id, label, weight, time_discount, emotion_amplifier, updated_at FROM core_values WHERE id = ?',
    ).get(id);
    return row ? this.toValue(row) : undefined;
  }

  /** 获取全部价值 */
  getAll(): Map<ValueId, CoreValue> {
    const rows = this.db.prepare<ValueRow>(
      'SELECT id, label, weight, time_discount, emotion_amplifier, updated_at FROM core_values',
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
    this.db.prepare<void>('DELETE FROM core_values WHERE 1=1').run();
  }

  /** 按原始数据插入（恢复用，保留原 ID） */
  insert(value: CoreValue): void {
    const td = Number.isFinite(value.timeDiscount) ? value.timeDiscount : 0.5;
    const ea = Number.isFinite(value.emotionAmplifier) ? value.emotionAmplifier : 1.0;
    this.db.prepare<void>(
      `INSERT INTO core_values (id, label, weight, time_discount, emotion_amplifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, weight=excluded.weight, time_discount=excluded.time_discount, emotion_amplifier=excluded.emotion_amplifier, updated_at=excluded.updated_at`,
    ).run(value.id, value.label, value.weight, td, ea, value.updatedAt);
  }

  private toValue(row: ValueRow): CoreValue {
    return {
      id: row.id,
      label: row.label,
      weight: row.weight,
      timeDiscount: row.time_discount,
      emotionAmplifier: row.emotion_amplifier,
      updatedAt: row.updated_at,
    };
  }
}
