/**
 * 生存锚点领域服务 — 纯业务逻辑，通过 SyncWriteUnitOfWork 访问数据
 * 零 node:* 依赖，可在任何运行时使用
 */

import type { KernelClock, KernelRandom } from '../../ports/host-adapters.js';
import type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from '../../ports/sync-unit-of-work.js';
import type { SurvivalAnchor, SurvivalAnchorKind, SurvivalAnchorPatch } from './anchor-types.js';
import {
  anchorById, allAnchors,
  createAnchorCmd, updateAnchorCmd, deleteAnchorCmd,
  deleteAllAnchorsCmd, upsertAnchorCmd,
} from './anchor-queries.js';

/* ── 验证函数 ── */

const VALID_KINDS: readonly SurvivalAnchorKind[] = ['constraint', 'threshold', 'must_have'];

export function assertKind(kind: string): asserts kind is SurvivalAnchorKind {
  if (!(VALID_KINDS as readonly string[]).includes(kind)) {
    throw new RangeError(`锚点类型必须是 ${VALID_KINDS.join(', ')} 之一，收到 ${kind}`);
  }
}

export function assertSeverity(severity: number): void {
  if (!Number.isFinite(severity) || severity < 1 || severity > 5 || !Number.isInteger(severity)) {
    throw new RangeError(`严重度必须为 1-5 的整数，收到 ${severity}`);
  }
}

/* ── 领域服务函数 ── */

export function createAnchor(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  random: KernelRandom,
  label: string,
  kind: SurvivalAnchorKind,
  value: unknown,
  severity: number,
): SurvivalAnchor {
  assertKind(kind);
  assertSeverity(severity);
  const id = random.uuid('anchor');
  const now = clock.now();
  tx.execute(createAnchorCmd({
    id, label, kind,
    valueJson: JSON.stringify(value ?? null),
    severity, createdAt: now, updatedAt: now,
  }));
  return { id, label, kind, value, severity, createdAt: now, updatedAt: now };
}

export function updateAnchor(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  id: string,
  patch: SurvivalAnchorPatch,
): SurvivalAnchor | undefined {
  const current = getAnchorById(tx, id);
  if (!current) return undefined;

  const now = clock.now();
  const nextKind = patch.kind ?? current.kind;
  const nextSeverity = patch.severity ?? current.severity;
  const nextValue = Object.prototype.hasOwnProperty.call(patch, 'value') ? patch.value : current.value;

  assertKind(nextKind);
  assertSeverity(nextSeverity);

  const next: SurvivalAnchor = {
    id,
    label: patch.label ?? current.label,
    kind: nextKind,
    value: nextValue,
    severity: nextSeverity,
    createdAt: current.createdAt,
    updatedAt: now,
  };

  tx.execute(updateAnchorCmd({
    id, label: next.label, kind: next.kind,
    valueJson: JSON.stringify(next.value ?? null),
    severity: next.severity, updatedAt: now,
  }));

  return next;
}

export function getAnchorById(tx: SyncReadUnitOfWork, id: string): SurvivalAnchor | null {
  return tx.queryOne(anchorById(id));
}

export function getAllAnchors(tx: SyncReadUnitOfWork): SurvivalAnchor[] {
  return [...tx.queryMany(allAnchors())];
}

export function deleteAnchor(tx: SyncWriteUnitOfWork, id: string): boolean {
  return tx.execute(deleteAnchorCmd(id)).rowsAffected > 0;
}

export function deleteAllAnchors(tx: SyncWriteUnitOfWork): void {
  tx.execute(deleteAllAnchorsCmd());
}

export function upsertAnchor(tx: SyncWriteUnitOfWork, anchor: SurvivalAnchor): void {
  tx.execute(upsertAnchorCmd({
    id: anchor.id, label: anchor.label, kind: anchor.kind,
    valueJson: JSON.stringify(anchor.value ?? null),
    severity: anchor.severity,
    createdAt: anchor.createdAt, updatedAt: anchor.updatedAt,
  }));
}
