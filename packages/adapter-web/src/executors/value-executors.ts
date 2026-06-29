/**
 * Web adapter: core_values executors.
 *
 * Mirrors the SQLite executor surface for core values. Persisted as a
 * single-table dataset; updates use copy-on-write to play nice with the
 * UoW rollback snapshot.
 */

import {
  VALUE_QUERY_BY_ID,
  VALUE_QUERY_ALL,
  VALUE_CMD_CREATE,
  VALUE_CMD_UPDATE,
  VALUE_CMD_DELETE,
  VALUE_CMD_DELETE_ALL,
  VALUE_CMD_UPSERT,
  type CoreValue,
  type ValueId,
  type CreateValueParams,
  type UpdateValueParams,
  type ValueByIdParams,
  type ValueAllParams,
  type DeleteValueParams,
  type DeleteAllValuesParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';

const TABLE = 'core_values';

/* ADR-0056 K5b：adapter-web 是单租户本地库（无 TenantDatabase rewriter），故按 **persona_id** 隔离即可
 * （一个本地用户可有多 persona）。所有写入路径都落 persona_id，故读取直接比对（无需 ?? 'default' hedge）。 */
function personaOf(row: Record<string, unknown>): string {
  return row['persona_id'] as string;
}

function rowToValue(row: Record<string, unknown>): CoreValue {
  return {
    id: row['id'] as ValueId,
    label: row['label'] as string,
    weight: row['weight'] as number,
    timeDiscount: row['time_discount'] as number,
    emotionAmplifier: row['emotion_amplifier'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

function valueToRow(v: CreateValueParams): Record<string, unknown> {
  return {
    id: v.id,
    persona_id: v.personaId,
    label: v.label,
    weight: v.weight,
    time_discount: v.timeDiscount,
    emotion_amplifier: v.emotionAmplifier,
    updated_at: v.updatedAt,
  };
}

export function registerValueExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<CoreValue, ValueByIdParams>(VALUE_QUERY_BY_ID, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const row = tables.find(TABLE, (r) => r['id'] === p.id && personaOf(r) === p.personaId);
    return row ? rowToValue(row) : null;
  });

  registry.registerQuery<CoreValue, ValueAllParams>(VALUE_QUERY_ALL, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const rows = tables.filter(TABLE, (r) => personaOf(r) === p.personaId);
    rows.sort((a, b) => Number(b['weight']) - Number(a['weight']) || String(a['id']).localeCompare(String(b['id'])));
    return rows.map(rowToValue);
  });

  registry.registerCommand<CreateValueParams>(VALUE_CMD_CREATE, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    if (tables.find(TABLE, (r) => r['id'] === p.id)) {
      throw new Error(`core value already exists: ${p.id}`);
    }
    tables.upsert(TABLE, valueToRow(p));
    return { rowsAffected: 1 };
  });

  registry.registerCommand<UpdateValueParams>(VALUE_CMD_UPDATE, (tables, p) => {
    const existing = tables.find(TABLE, (r) => r['id'] === p.id && personaOf(r) === p.personaId);
    if (!existing) return { rowsAffected: 0 };
    const merged = {
      ...existing,
      persona_id: p.personaId,
      ...(p.patch.weight !== undefined ? { weight: p.patch.weight } : {}),
      ...(p.patch.timeDiscount !== undefined ? { time_discount: p.patch.timeDiscount } : {}),
      ...(p.patch.emotionAmplifier !== undefined ? { emotion_amplifier: p.patch.emotionAmplifier } : {}),
      updated_at: p.updatedAt,
    };
    tables.upsert(TABLE, merged);
    return { rowsAffected: 1 };
  });

  registry.registerCommand<DeleteValueParams>(VALUE_CMD_DELETE, (tables, p) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    /* 只删属于该 persona 的该 id（防跨 persona 误删）。 */
    const row = tables.find(TABLE, (r) => r['id'] === p.id && personaOf(r) === p.personaId);
    if (!row) return { rowsAffected: 0 };
    return { rowsAffected: tables.delete(TABLE, String(p.id)) ? 1 : 0 };
  });

  registry.registerCommand<DeleteAllValuesParams>(VALUE_CMD_DELETE_ALL, (tables, p) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    /* 只清该 persona 的价值（不波及同库其他 persona）。 */
    const mine = tables.filter(TABLE, (r) => personaOf(r) === p.personaId);
    for (const r of mine) tables.delete(TABLE, String(r['id']));
    return { rowsAffected: mine.length };
  });

  registry.registerCommand<CreateValueParams>(VALUE_CMD_UPSERT, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    tables.upsert(TABLE, valueToRow(p));
    return { rowsAffected: 1 };
  });
}
