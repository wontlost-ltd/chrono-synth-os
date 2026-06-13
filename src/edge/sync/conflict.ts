/**
 * 冲突解决（ADR-0052 Edge-P3）— 多设备同步的确定性三分法。
 *
 * 端侧自治 + 云同步必然产生多设备并发修改。按变更类别用不同策略（backend 研究三分法），
 * 核心红线：**身份核变更绝不 last-write-wins**——多设备对 value/narrative/规则的冲突默认进
 * pending 人工/门审批（与 ADR-0047 蒸馏门、ADR-0051/0052 「不自动改身份核」一致）。
 *
 *   - fact（append-only 事实/事件）：用 (deviceId, seq) 去重后**合并**——同设备同 seq 是同一变更，
 *     不同设备的事实天然可共存（append-only，无覆盖）。
 *   - projection（可合并读模型/派生统计）：不作为冲突源，**重建**（从事实重算，丢弃旧投影）。
 *   - identity（身份核：value/narrative/L0-L3/规则/模板）：冲突 → **pending**，绝不自动合并/覆盖。
 *
 * 纯确定性、零依赖：同输入 → 同 resolution。
 */

import type { ChangeClass, OutboxEntry } from './outbox.js';

/** 一个待解决的变更（本地或远端）。 */
export interface ChangeRef {
  readonly deviceId: string;
  readonly seq: number;
  readonly changeClass: ChangeClass;
  readonly opKind: string;
  /** 目标实体 id（如 valueId / memoryId），用于判定是否「同一目标的冲突」。 */
  readonly targetId: string;
}

export type Resolution =
  | { readonly action: 'merge'; readonly entries: readonly ChangeRef[] }      /* fact：去重后保留 */
  | { readonly action: 'rebuild'; readonly targetId: string }                 /* projection：重建 */
  | { readonly action: 'pending'; readonly conflict: readonly ChangeRef[] };  /* identity：进审批 */

/**
 * 从 OutboxEntry 投影出 ChangeRef。targetId 从 payload.id / payload.targetId 取；**取不到时
 * 用唯一占位 `deviceId:seq`**（避免无目标变更被误归到同一目标 ""——空串会让无关变更误判冲突）。
 */
export function toChangeRef(e: OutboxEntry): ChangeRef {
  const raw = e.payload['id'] ?? e.payload['targetId'];
  const targetId = (raw === undefined || raw === null || String(raw).length === 0)
    ? `${e.deviceId}:${e.seq}`
    : String(raw);
  return { deviceId: e.deviceId, seq: e.seq, changeClass: e.changeClass, opKind: e.opKind, targetId };
}

/**
 * 解决一组针对**同一目标**的并发变更（来自多设备）。
 * **强制单目标契约**（Codex 复审）：传入跨多个 targetId 抛错——避免「fact 分支不看 targetId」
 * 把不同目标的变更错误合并。跨目标请用 resolveConflictsByTarget。
 */
export function resolveConflict(changes: readonly ChangeRef[]): Resolution {
  if (changes.length === 0) return { action: 'merge', entries: [] };
  const targets = new Set(changes.map((c) => c.targetId));
  if (targets.size > 1) {
    throw new Error(`resolveConflict 要求单一 targetId（收到 ${targets.size} 个）；跨目标请用 resolveConflictsByTarget`);
  }

  /* 类别以「最高风险」为准：任一身份核变更 → 整组按 identity 处理（保守）。 */
  const hasIdentity = changes.some((c) => c.changeClass === 'identity');
  if (hasIdentity) {
    /* 身份核：仅当确实存在多个不同来源的并发变更才算冲突；单一变更不阻塞。 */
    const identityChanges = changes.filter((c) => c.changeClass === 'identity');
    const distinctSources = new Set(identityChanges.map((c) => `${c.deviceId}:${c.seq}`));
    if (distinctSources.size <= 1) {
      /* 单一身份核变更，无并发冲突 → 仍走正常审批路径（pending），绝不自动应用。 */
      return { action: 'pending', conflict: identityChanges };
    }
    /* 多设备并发身份核变更 → pending，绝不 last-write-wins。 */
    return { action: 'pending', conflict: identityChanges };
  }

  const allProjection = changes.every((c) => c.changeClass === 'projection');
  if (allProjection) {
    return { action: 'rebuild', targetId: changes[0].targetId };
  }

  /* 其余（全 fact，或 fact+projection 混合且无 identity）：fact 去重合并。 */
  const facts = changes.filter((c) => c.changeClass === 'fact');
  return { action: 'merge', entries: dedupe(facts) };
}

/**
 * 跨目标批量解决：自动按 targetId 分组，对每组调 resolveConflict，返回 targetId → Resolution。
 * 这是调用方的推荐入口（resolveConflict 是单目标原语）。
 */
export function resolveConflictsByTarget(changes: readonly ChangeRef[]): Map<string, Resolution> {
  const groups = new Map<string, ChangeRef[]>();
  for (const c of changes) (groups.get(c.targetId) ?? groups.set(c.targetId, []).get(c.targetId)!).push(c);
  const out = new Map<string, Resolution>();
  for (const [targetId, group] of groups) out.set(targetId, resolveConflict(group));
  return out;
}

/** 按 (deviceId, seq) 去重——同设备同 seq 是同一变更（重传/多路径到达）。 */
function dedupe(changes: readonly ChangeRef[]): ChangeRef[] {
  const seen = new Set<string>();
  const out: ChangeRef[] = [];
  for (const c of changes) {
    const key = `${c.deviceId}:${c.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
