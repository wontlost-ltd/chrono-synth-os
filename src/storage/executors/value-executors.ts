/**
 * 价值维度 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import type { IDatabase } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  VALUE_QUERY_BY_ID, VALUE_QUERY_ALL,
  VALUE_CMD_CREATE, VALUE_CMD_UPDATE, VALUE_CMD_DELETE,
  VALUE_CMD_DELETE_ALL, VALUE_CMD_UPSERT,
} from '@chrono/kernel';
import type { CoreValue, ValueId, CreateValueParams, UpdateValueParams } from '@chrono/kernel';

interface ValueRow {
  id: string;
  label: string;
  weight: number;
  time_discount: number;
  emotion_amplifier: number;
  updated_at: number;
}

function toValue(row: ValueRow): CoreValue {
  return {
    id: row.id,
    label: row.label,
    weight: row.weight,
    timeDiscount: row.time_discount,
    emotionAmplifier: row.emotion_amplifier,
    updatedAt: row.updated_at,
  };
}

export function registerValueExecutors(): void {
  registerQuery<CoreValue | null, { id: ValueId }>(VALUE_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<ValueRow>(
      'SELECT id, label, weight, time_discount, emotion_amplifier, updated_at FROM core_values WHERE id = ?',
    ).get(params.id);
    return row ? toValue(row) : null;
  });

  registerQuery<CoreValue[], void>(VALUE_QUERY_ALL, (db: IDatabase) => {
    const rows = db.prepare<ValueRow>(
      'SELECT id, label, weight, time_discount, emotion_amplifier, updated_at FROM core_values',
    ).all();
    return rows.map(toValue);
  });

  registerCommand<CreateValueParams>(VALUE_CMD_CREATE, (db, p) => {
    db.prepare<void>(
      'INSERT INTO core_values (id, label, weight, time_discount, emotion_amplifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(p.id, p.label, p.weight, p.timeDiscount, p.emotionAmplifier, p.updatedAt);
    return { rowsAffected: 1 };
  });

  registerCommand<UpdateValueParams>(VALUE_CMD_UPDATE, (db, p) => {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (p.patch.weight !== undefined) { sets.push('weight = ?'); vals.push(p.patch.weight); }
    if (p.patch.timeDiscount !== undefined) { sets.push('time_discount = ?'); vals.push(p.patch.timeDiscount); }
    if (p.patch.emotionAmplifier !== undefined) { sets.push('emotion_amplifier = ?'); vals.push(p.patch.emotionAmplifier); }
    sets.push('updated_at = ?');
    vals.push(p.updatedAt);
    const result = db.prepare<void>(
      `UPDATE core_values SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...vals, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<{ id: ValueId }>(VALUE_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>('DELETE FROM core_values WHERE id = ?').run(p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(VALUE_CMD_DELETE_ALL, (db: IDatabase) => {
    db.prepare<void>('DELETE FROM core_values WHERE 1=1').run();
    return { rowsAffected: 0 };
  });

  registerCommand<CreateValueParams>(VALUE_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO core_values (id, label, weight, time_discount, emotion_amplifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, weight=excluded.weight, time_discount=excluded.time_discount, emotion_amplifier=excluded.emotion_amplifier, updated_at=excluded.updated_at`,
    ).run(p.id, p.label, p.weight, p.timeDiscount, p.emotionAmplifier, p.updatedAt);
    return { rowsAffected: 1 };
  });
}
