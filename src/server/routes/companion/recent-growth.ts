/**
 * 「近期成长」一句话（ADR-0054 Phase 5 主动响应增强的 recentGrowth 来源）。
 *
 * 把已存的 persona drift 报告（getLatest 读库，cheap 非重算）经 driftReportToGrowth 渲染成探索方向，
 * 取最强一条方向变成确定性第一人称成长描述——喂给 OfflineConversationResponder 的 proactiveReply.recentGrowth，
 * 让知识回应的主动 follow-up 真带「我最近也在变化：<成长>」，而非只有泛泛邀请。
 *
 * 零 LLM、确定性（同一份 drift 报告 → 同一句话）。无可对比基线 / 无明显方向 → undefined（不带成长片段）。
 */

import type { IDatabase } from '../../../storage/database.js';
import { PersonaDriftAnalyzer } from '../../../safety/persona-drift-analyzer.js';
import { driftReportToGrowth } from '@chrono/contracts';

/** 统计租户快照数（与 me.ts countTenantSnapshots 同口径），判断是否有可对比基线。 */
function countTenantSnapshots(db: IDatabase, tenantId: string): number {
  const row = db.prepare<{ n: number }>(
    `SELECT COUNT(*) AS n FROM snapshots
      WHERE tenant_id = ? OR (tenant_id IS NULL AND ? = 'default')`,
  ).get(tenantId, tenantId);
  return row?.n ?? 0;
}

/**
 * 取该租户近期最强探索方向，渲染成第一人称成长一句；无基线/无方向 → undefined。
 * 注：getLatest 读**已存**报告（alertLevel 等在生成时已固化），与 drift 阈值无关——故无需
 * resolveDriftThresholds，用默认构造的 analyzer 即可（少两次 config SELECT，Codex 复审建议）。
 */
export function buildRecentGrowthPhrase(db: IDatabase, tenantId: string): string | undefined {
  try {
    const report = new PersonaDriftAnalyzer(db).getLatest(tenantId);
    const hasBaseline = countTenantSnapshots(db, tenantId) >= 2;
    const growth = driftReportToGrowth(report, hasBaseline);
    if (!growth.hasBaseline || growth.directions.length === 0) return undefined;

    /* driftReportToGrowth 已按 magnitude 降序——取最强一条方向。steady 不算「在变化」，跳过。 */
    const top = growth.directions.find((d) => d.direction !== 'steady');
    if (!top) return undefined;
    const verb = top.direction === 'toward' ? '越来越看重' : '逐渐放下';
    return `我${verb}「${top.label}」`;
  } catch {
    /* drift 读取失败不影响对话主流程——退化为无成长片段（follow-up 仅泛泛邀请）。 */
    return undefined;
  }
}
