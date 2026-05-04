/**
 * 对话接入层共享类型（P1-C）
 *
 * 重要：对话历史由调用方持有；服务端只持久化每次消息的审计快照。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';

/** ValueGuard 决策动作 */
export type GuardAction = 'pre_block' | 'post_redact' | 'escalate' | null;

/** 调用方提供的对话历史片段 */
export interface ConversationHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** 检索到的相关知识片段 */
export interface RelevantKnowledge {
  id: string;
  title: string;
  content: string;
  relevance: number;  // 0..1
}

/** ValueGuard.preCheck 输出 */
export interface PreCheckResult {
  action: GuardAction;
  reason?: string;
  matchedTopic?: string;
  matchedRule?: BehaviorBoundary['rule'];
}

/** ValueGuard.postCheck 输出 */
export interface PostCheckResult {
  action: GuardAction;
  reason?: string;
  matchedTopic?: string;
  redactedContent?: string;
}

/** 拼装好的 prompt 结构 */
export interface PromptParts {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** 对话消息（持久化形态） */
export interface ConversationMessage {
  id: string;
  tenantId: string;
  personaId: string;
  sessionId: string;
  messageId: string;
  externalUserId: string;
  userInput: string;
  assistantOutput: string;
  memoriesUsed: Array<{ id: string; title: string; relevance: number }>;
  shouldEscalate: boolean;
  confidenceScore: number;
  guardAction: GuardAction;
  guardReason: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  createdAt: number;
}

/** API 响应（不含内部字段如 tenantId） */
export interface ConversationResponse {
  sessionId: string;
  messageId: string;
  response: string;
  memoriesUsed: Array<{ id: string; title: string; relevance: number }>;
  shouldEscalate: boolean;
  confidenceScore: number;
  guardAction: GuardAction;
  guardReason?: string;
  durationMs: number;
  createdAt: number;
}

export function toConversationResponse(msg: ConversationMessage): ConversationResponse {
  return {
    sessionId: msg.sessionId,
    messageId: msg.messageId,
    response: msg.assistantOutput,
    memoriesUsed: msg.memoriesUsed,
    shouldEscalate: msg.shouldEscalate,
    confidenceScore: msg.confidenceScore,
    guardAction: msg.guardAction,
    guardReason: msg.guardReason ?? undefined,
    durationMs: msg.durationMs,
    createdAt: msg.createdAt,
  };
}
