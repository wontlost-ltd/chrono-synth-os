/**
 * ChronoCompanion C 端数据契约 —「我的数字人」主页 + 成长视图（ADR-0046 / roadmap Phase 2.1）。
 *
 * 这是消费端外壳读取的 DTO，**不是**企业治理视角。同一份内核数据（core value /
 * memory / narrative / drift 分析）在这里被重新组织成「陪伴」语义：
 *   - 企业版把 persona drift 渲染成「policy violation / alert」；
 *   - companion 把同一份 DriftReport 渲染成「你最近探索的方向」（exploration），
 *     alertLevel 不再是告警等级，而是「探索强度」。
 *
 * 端到端类型安全：后端 src/server/routes/companion/me.ts 用这些 schema 序列化，
 * 前端 apps/companion-web 用 z.infer 出来的类型消费。Zod schema + schemaVersion 字面量
 * + .strict()，与既有 contracts（如 conflict-inbox）保持一致。
 */

import { z } from 'zod';

/* ── /api/v1/companion/me —「我的数字人」主页 ───────────────────────── */

/** 单条核心价值的 C 端视图（隐藏企业版的 timeDiscount/emotionAmplifier 调参细节）。 */
export const CompanionValueV1Schema = z.object({
  id: z.string().min(1),
  /** 价值标签，如「好奇心」「稳定」。 */
  label: z.string().min(1),
  /** 当前权重 0..1，C 端用来画「我现在最看重什么」。 */
  weight: z.number().min(0).max(1),
}).strict();

/** 单条记忆的 C 端摘要视图（只取陪伴所需字段，不暴露 decay/access 内部状态）。 */
export const CompanionMemoryV1Schema = z.object({
  id: z.string().min(1),
  /** 记忆类型，如 episodic/semantic。 */
  kind: z.string().min(1),
  /** 记忆内容文本。 */
  content: z.string(),
  /** 情绪价 -1..1（正=愉快，负=不快），C 端可用于配色/表情。 */
  valence: z.number().min(-1).max(1),
  /** 显著度 0..1，越高越「印象深刻」。 */
  salience: z.number().min(0).max(1),
  /** 创建时间（epoch ms）。 */
  createdAt: z.number().int().nonnegative(),
}).strict();

export const CompanionMeV1Schema = z.object({
  schemaVersion: z.literal('companion-me.v1'),
  /** 数字人自述（narrative.get()），可能为空字符串（新数字人尚无叙事）。 */
  narrative: z.string(),
  /** 当前最看重的价值，按 weight 降序，最多取若干条。 */
  topValues: z.array(CompanionValueV1Schema),
  /** 最近的记忆，按 createdAt 降序。 */
  recentMemories: z.array(CompanionMemoryV1Schema),
  /** 价值总数 / 记忆总数，用于主页概览数字（避免前端再拉全量）。 */
  valueCount: z.number().int().nonnegative(),
  memoryCount: z.number().int().nonnegative(),
}).strict();

/* ── /api/v1/companion/me/growth —「你最近探索的方向」 ───────────────── */

/**
 * 探索强度 = 企业版 drift alertLevel 的 C 端重命名。
 *   ok → steady（稳定）；warning → exploring（正在探索）；critical → leaping（大幅探索）。
 * 语义不变（同一份 DriftReport），只是不把「探索」描述成「违规」。
 */
export const ExplorationIntensityV1Schema = z.enum(['steady', 'exploring', 'leaping']);

/** 单个价值方向上的探索（由 ValueDrift 映射；direction 由 delta 符号决定）。 */
export const ExplorationDirectionV1Schema = z.object({
  valueId: z.string().min(1),
  label: z.string().min(1),
  /** 探索方向：toward=越来越看重，away=越来越不看重，steady=基本没变。 */
  direction: z.enum(['toward', 'away', 'steady']),
  /** 探索幅度 = |delta|，0..1，越大走得越远。 */
  magnitude: z.number().min(0).max(1),
  intensity: ExplorationIntensityV1Schema,
}).strict();

export const CompanionGrowthV1Schema = z.object({
  schemaVersion: z.literal('companion-growth.v1'),
  /** 是否已有成长数据（无基线快照时为 false，前端显示「还在认识你」空态）。 */
  hasBaseline: z.boolean(),
  /** 分析时间（epoch ms），无数据时为 null。 */
  analyzedAt: z.number().int().nonnegative().nullable(),
  /** 整体探索强度（由 overall drift + alertLevel 映射）。 */
  overallIntensity: ExplorationIntensityV1Schema,
  /** 各价值方向上的探索明细，按 magnitude 降序。 */
  directions: z.array(ExplorationDirectionV1Schema),
}).strict();

export type CompanionValueV1 = z.infer<typeof CompanionValueV1Schema>;
export type CompanionMemoryV1 = z.infer<typeof CompanionMemoryV1Schema>;
export type CompanionMeV1 = z.infer<typeof CompanionMeV1Schema>;
export type ExplorationIntensityV1 = z.infer<typeof ExplorationIntensityV1Schema>;
export type ExplorationDirectionV1 = z.infer<typeof ExplorationDirectionV1Schema>;
export type CompanionGrowthV1 = z.infer<typeof CompanionGrowthV1Schema>;
