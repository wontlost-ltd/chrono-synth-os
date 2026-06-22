/**
 * 价值维度领域服务 — 纯业务逻辑，通过 SyncWriteUnitOfWork 访问数据
 * 零 node:* 依赖，可在任何运行时使用
 */

import type { KernelClock, KernelRandom } from '../../ports/host-adapters.js';
import type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from '../../ports/sync-unit-of-work.js';
import type { CoreValue, CoreValuePatch, ValueId } from './value-types.js';
import {
  valueById, allValues,
  createValueCmd, updateValueCmd, deleteValueCmd,
  deleteAllValuesCmd, upsertValueCmd,
} from './value-queries.js';

/* ── 验证函数 ── */

export function assertWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new RangeError(`价值权重必须在 0-1 之间，收到 ${weight}`);
  }
}

export function assertTimeDiscount(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`时间折扣必须在 0-1 之间，收到 ${value}`);
  }
}

export function assertEmotionAmplifier(value: number): void {
  if (!Number.isFinite(value) || value < 0.5 || value > 2.0) {
    throw new RangeError(`情绪放大必须在 0.5-2.0 之间，收到 ${value}`);
  }
}

/* ── 领域服务函数 ── */

export function createValue(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  random: KernelRandom,
  label: string,
  weight: number,
  timeDiscount = 0.5,
  emotionAmplifier = 1.0,
  personaId = 'default',
): CoreValue {
  assertWeight(weight);
  assertTimeDiscount(timeDiscount);
  assertEmotionAmplifier(emotionAmplifier);
  const id = random.uuid('val');
  const now = clock.now();
  tx.execute(createValueCmd({ id, personaId, label, weight, timeDiscount, emotionAmplifier, updatedAt: now }));
  return { id, label, weight, timeDiscount, emotionAmplifier, updatedAt: now };
}

export function updateValue(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  id: ValueId,
  patch: CoreValuePatch,
  personaId = 'default',
): CoreValue | undefined {
  if (patch.weight !== undefined) assertWeight(patch.weight);
  if (patch.timeDiscount !== undefined) assertTimeDiscount(patch.timeDiscount);
  if (patch.emotionAmplifier !== undefined) assertEmotionAmplifier(patch.emotionAmplifier);

  const hasPatch = patch.weight !== undefined
    || patch.timeDiscount !== undefined
    || patch.emotionAmplifier !== undefined;
  if (!hasPatch) return getValueById(tx, id, personaId) ?? undefined;

  const now = clock.now();
  const result = tx.execute(updateValueCmd({ id, personaId, patch, updatedAt: now }));
  if (result.rowsAffected === 0) return undefined;
  return getValueById(tx, id, personaId) ?? undefined;
}

export function getValueById(tx: SyncReadUnitOfWork, id: ValueId, personaId = 'default'): CoreValue | null {
  return tx.queryOne(valueById(id, personaId));
}

export function getAllValues(tx: SyncReadUnitOfWork, personaId = 'default'): Map<ValueId, CoreValue> {
  const values = tx.queryMany(allValues(personaId));
  const map = new Map<ValueId, CoreValue>();
  for (const v of values) map.set(v.id, v);
  return map;
}

export function deleteValue(tx: SyncWriteUnitOfWork, id: ValueId, personaId = 'default'): boolean {
  return tx.execute(deleteValueCmd(id, personaId)).rowsAffected > 0;
}

export function deleteAllValues(tx: SyncWriteUnitOfWork, personaId = 'default'): void {
  tx.execute(deleteAllValuesCmd(personaId));
}

export function upsertValue(tx: SyncWriteUnitOfWork, value: CoreValue, personaId = 'default'): void {
  const td = Number.isFinite(value.timeDiscount) ? value.timeDiscount : 0.5;
  const ea = Number.isFinite(value.emotionAmplifier) ? value.emotionAmplifier : 1.0;
  tx.execute(upsertValueCmd({
    id: value.id, personaId, label: value.label, weight: value.weight,
    timeDiscount: td, emotionAmplifier: ea, updatedAt: value.updatedAt,
  }));
}
