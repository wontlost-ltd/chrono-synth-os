/**
 * ChronoCompanion C 端主动消息（nudge）列表契约 —
 * `GET /api/v1/companion/me/nudges`（ADR-0054 主动性）。
 *
 * 数字人据内部信号「主动开口」产生的消息，C 端拉取展示「TA 主动跟我说的」。单条形状对齐后端
 * toCompanionNudge（proactive_messages row 的 C 端投影，隐藏 signal_type/source_id 等溯源内部）。
 * 共享 contract 让 web/mobile 前端与后端 DTO 单一来源，杜绝漂移。
 */

import { z } from 'zod';

/** 单条主动消息（C 端展示形状）。 */
export const CompanionNudgeV1Schema = z.object({
  id: z.string(),
  /** 消息类别：memory / narrative / growth / general（供分组渲染）。 */
  kind: z.string(),
  /** 确定性 composer 产出的主动文本（第一人称）。 */
  body: z.string(),
  /** 'unread' | 'read' | 'dismissed'。 */
  status: z.string(),
  /** 入队时间（epoch ms）。 */
  createdAt: z.number().int().nonnegative(),
  /** 标记已读时间（epoch ms）；未读为 null。 */
  readAt: z.number().int().nonnegative().nullable(),
}).strict();

export const CompanionNudgeListV1Schema = z.object({
  schemaVersion: z.literal('companion-nudge-list.v1'),
  items: z.array(CompanionNudgeV1Schema),
}).strict();

export type CompanionNudgeV1 = z.infer<typeof CompanionNudgeV1Schema>;
export type CompanionNudgeListV1 = z.infer<typeof CompanionNudgeListV1Schema>;
