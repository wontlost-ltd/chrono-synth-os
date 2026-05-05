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
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';

const TABLE = 'core_values';

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
    label: v.label,
    weight: v.weight,
    time_discount: v.timeDiscount,
    emotion_amplifier: v.emotionAmplifier,
    updated_at: v.updatedAt,
  };
}

export function registerValueExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<CoreValue, { id: ValueId }>(VALUE_QUERY_BY_ID, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const row = tables.find(TABLE, (r) => r['id'] === p.id);
    return row ? rowToValue(row) : null;
  });

  registry.registerQuery<CoreValue, void>(VALUE_QUERY_ALL, (tables) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const rows = tables.filter(TABLE, () => true);
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
    const existing = tables.find(TABLE, (r) => r['id'] === p.id);
    if (!existing) return { rowsAffected: 0 };
    const merged = {
      ...existing,
      ...(p.patch.weight !== undefined ? { weight: p.patch.weight } : {}),
      ...(p.patch.timeDiscount !== undefined ? { time_discount: p.patch.timeDiscount } : {}),
      ...(p.patch.emotionAmplifier !== undefined ? { emotion_amplifier: p.patch.emotionAmplifier } : {}),
      updated_at: p.updatedAt,
    };
    tables.upsert(TABLE, merged);
    return { rowsAffected: 1 };
  });

  registry.registerCommand<{ id: ValueId }>(VALUE_CMD_DELETE, (tables, p) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    return { rowsAffected: tables.delete(TABLE, String(p.id)) ? 1 : 0 };
  });

  registry.registerCommand<void>(VALUE_CMD_DELETE_ALL, (tables) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    const all = tables.filter(TABLE, () => true);
    for (const r of all) tables.delete(TABLE, String(r['id']));
    return { rowsAffected: all.length };
  });

  registry.registerCommand<CreateValueParams>(VALUE_CMD_UPSERT, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    tables.upsert(TABLE, valueToRow(p));
    return { rowsAffected: 1 };
  });
}
