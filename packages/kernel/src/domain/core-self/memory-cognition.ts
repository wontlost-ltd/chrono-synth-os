/**
 * 记忆认知动力学 — 纯计算函数，零 node:* 依赖
 */

import type { MemoryKind, MemoryNode, MemoryCognitionConfig } from './memory-types.js';

/* ── 验证 ── */

export function assertValence(valence: number): void {
  if (!Number.isFinite(valence) || valence < -1 || valence > 1) {
    throw new RangeError(`情感色调必须在 -1 到 1 之间，收到 ${valence}`);
  }
}

export function assertSalience(salience: number): void {
  if (!Number.isFinite(salience) || salience < 0 || salience > 1) {
    throw new RangeError(`重要性必须在 0-1 之间，收到 ${salience}`);
  }
}

export function assertStrength(strength: number): void {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new RangeError(`关联强度必须在 0-1 之间，收到 ${strength}`);
  }
}

/* ── 衰减速率计算 ── */

export function computeLambda(
  config: MemoryCognitionConfig['decay'],
  kind: MemoryKind,
  valence: number,
  accessCount: number,
): number {
  const { baseLambda, valenceWeight, accessBoost, kindFactors } = config;
  const kindFactor = kindFactors[kind] ?? 1.0;
  const raw = baseLambda * (1 - valenceWeight * Math.abs(valence)) * kindFactor / (1 + accessBoost * accessCount);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/* ── 工作记忆评分 ── */

export function computeWorkingMemoryScore(
  config: MemoryCognitionConfig['workingMemory'],
  mem: MemoryNode,
  now: number,
): number {
  const recencyFactor = Math.exp(-config.recencyDecay * (now - mem.lastAccessedAt));
  const accessFactor = 1 + Math.log(1 + mem.accessCount);
  return mem.salience * recencyFactor * accessFactor;
}

/* ── 衰减计算 ── */

export function applyDecay(salience: number, lambda: number, dt: number): number {
  if (dt <= 0 || lambda <= 0) return salience;
  const result = salience * Math.exp(-lambda * dt);
  return result < 0 ? 0 : result;
}
