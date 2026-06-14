/**
 * ChronoCompanion C 端数据契约 — 跟数字人对话（ADR-0047「跑为你拥有的人格」C 端落地）。
 *
 * 论点核心：数字人**运行时零 LLM**——回应由确定性 OfflineConversationResponder 据人格叙事 + 自己
 * 沉淀的记忆（关键词检索）生成。离线/无云仍能聊；LLM 只在成长阶段当老师，不在运行时。
 *
 * 端到端类型安全：后端 src/server/routes/companion/chat.ts 序列化，前端 web/mobile 消费。
 */

import { z } from 'zod';

/** 用户消息上限（防滥用；C 端聊天单条）。 */
export const COMPANION_CHAT_MESSAGE_MAX_LEN = 2000;

export const CompanionChatRequestV1Schema = z.object({
  /** 用户对数字人说的话。 */
  message: z.string().min(1).max(COMPANION_CHAT_MESSAGE_MAX_LEN),
}).strict();

export type CompanionChatRequestV1 = z.infer<typeof CompanionChatRequestV1Schema>;

/** 回应类型（与 OfflineResponseKind 同源）：知识落地 / 诚实离线 / 边界拒答 / 升级。 */
export const CompanionChatKindV1Schema = z.enum([
  'knowledge_grounded', 'honest_offline', 'boundary_block', 'boundary_escalate',
]);

export const CompanionChatResultV1Schema = z.object({
  schemaVersion: z.literal('companion-chat-result.v1'),
  /** 数字人的回应（第一人称，零 LLM 确定性生成）。 */
  reply: z.string(),
  /** 回应类型。 */
  kind: CompanionChatKindV1Schema,
  /** 置信度 [0,1]（离线回应天然低于 LLM；knowledge_grounded 取决于检索相关度）。 */
  confidence: z.number().min(0).max(1),
  /** 引用了几条自己的记忆（透明：让用户知道回应有据）。 */
  groundedMemoryCount: z.number().int().nonnegative(),
}).strict();

export type CompanionChatResultV1 = z.infer<typeof CompanionChatResultV1Schema>;
