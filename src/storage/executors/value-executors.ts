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
import type {
  CoreValue, CreateValueParams, UpdateValueParams,
  ValueByIdParams, ValueAllParams, DeleteValueParams, DeleteAllValuesParams,
} from '@chrono/kernel';

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
  /* ADR-0056 K5b：value 按 (tenant, persona) 隔离。tenant_id 由 TenantDatabase rewriter 自动注入
   * （INSERT 加列 + SELECT/UPDATE/DELETE 加 WHERE）；persona_id 这里**显式**线程（rewriter 只认 tenant）。
   * 主键仍 id（UUID 全局唯一），故 ON CONFLICT(id) 不变；persona 隔离靠**写 persona_id + 读按 persona 过滤**。 */
  registerQuery<CoreValue | null, ValueByIdParams>(VALUE_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<ValueRow>(
      'SELECT id, label, weight, time_discount, emotion_amplifier, updated_at FROM core_values WHERE id = ? AND persona_id = ?',
    ).get(params.id, params.personaId);
    return row ? toValue(row) : null;
  });

  registerQuery<CoreValue[], ValueAllParams>(VALUE_QUERY_ALL, (db: IDatabase, params) => {
    const rows = db.prepare<ValueRow>(
      'SELECT id, label, weight, time_discount, emotion_amplifier, updated_at FROM core_values WHERE persona_id = ?',
    ).all(params.personaId);
    return rows.map(toValue);
  });

  registerCommand<CreateValueParams>(VALUE_CMD_CREATE, (db, p) => {
    db.prepare<void>(
      'INSERT INTO core_values (id, persona_id, label, weight, time_discount, emotion_amplifier, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(p.id, p.personaId, p.label, p.weight, p.timeDiscount, p.emotionAmplifier, p.updatedAt);
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
      `UPDATE core_values SET ${sets.join(', ')} WHERE id = ? AND persona_id = ?`,
    ).run(...vals, p.id, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<DeleteValueParams>(VALUE_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>('DELETE FROM core_values WHERE id = ? AND persona_id = ?').run(p.id, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<DeleteAllValuesParams>(VALUE_CMD_DELETE_ALL, (db: IDatabase, p) => {
    /* persona 范围清空（WHERE persona_id；rewriter 再加 AND tenant_id）。 */
    db.prepare<void>('DELETE FROM core_values WHERE persona_id = ?').run(p.personaId);
    return { rowsAffected: 0 };
  });

  registerCommand<CreateValueParams>(VALUE_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO core_values (id, persona_id, label, weight, time_discount, emotion_amplifier, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET persona_id=excluded.persona_id, label=excluded.label, weight=excluded.weight, time_discount=excluded.time_discount, emotion_amplifier=excluded.emotion_amplifier, updated_at=excluded.updated_at`,
    ).run(p.id, p.personaId, p.label, p.weight, p.timeDiscount, p.emotionAmplifier, p.updatedAt);
    return { rowsAffected: 1 };
  });
}
