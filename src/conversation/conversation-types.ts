/**
 * 对话接入层共享类型（P1-C）
 *
 * 重要：对话历史由调用方持有；服务端只持久化每次消息的审计快照。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';

/**
 * ValueGuard 决策动作。
 * - llm_fallback：LLM 不可达且无离线人格回应能力时的服务降级（静态道歉）。
 * - autonomous_response：ADR-0047 自主模式，由确定性离线回应器据人格/知识生成，
 *   非故障，区别于 llm_fallback。
 */
export type GuardAction = 'pre_block' | 'post_redact' | 'escalate' | 'needs_confirmation' | 'quota_exceeded' | 'llm_fallback' | 'autonomous_response' | null;

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

/** 置信度计算因子（来源解释，给前端展示给用户） */
export interface ConfidenceFactor {
  name: string;
  weight: number;
  contribution: number;  /* +/- 数值，加到 score 上 */
  detail?: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface CalibratedConfidence {
  score: number;          /* 0..1 中心点 */
  level: ConfidenceLevel;
  interval: { lower: number; upper: number };  /* 95% 置信区间近似 */
  factors: ConfidenceFactor[];
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
  confidence: CalibratedConfidence;
  guardAction: GuardAction;
  guardReason: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  encryptionKeyRef: string | null;
  inputRedactedPiiCount: number;
  outputRedactedPiiCount: number;
  retentionClass: 'standard' | 'extended' | 'litigation_hold';
  createdAt: number;
}

/** API 响应（不含内部字段如 tenantId） */
export interface ConversationResponse {
  sessionId: string;
  messageId: string;
  response: string;
  memoriesUsed: Array<{ id: string; title: string; relevance: number }>;
  shouldEscalate: boolean;
  confidence: CalibratedConfidence;
  /** 兼容旧前端：等同 confidence.score */
  confidenceScore: number;
  guardAction: GuardAction;
  guardReason?: string;
  /** 当 guardAction='needs_confirmation' 时返回；下次重发请携带 */
  confirmationToken?: string;
  confirmationExpiresAt?: number;
  durationMs: number;
  createdAt: number;
}

export function toConversationResponse(
  msg: ConversationMessage,
  confirmation?: { token: string; expiresAt: number },
): ConversationResponse {
  return {
    sessionId: msg.sessionId,
    messageId: msg.messageId,
    response: msg.assistantOutput,
    memoriesUsed: msg.memoriesUsed,
    shouldEscalate: msg.shouldEscalate,
    confidence: msg.confidence,
    confidenceScore: msg.confidence.score,
    guardAction: msg.guardAction,
    guardReason: msg.guardReason ?? undefined,
    confirmationToken: confirmation?.token,
    confirmationExpiresAt: confirmation?.expiresAt,
    durationMs: msg.durationMs,
    createdAt: msg.createdAt,
  };
}
