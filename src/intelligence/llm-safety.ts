/**
 * LLM 安全管道 — 薄适配器，委托 kernel 纯函数
 * 保留模块级 safetyMetrics 单例以兼容现有消费方
 */

import type { ChatMessage, ChatResponse } from './llm-provider.js';
import {
  checkInputSafety as kernelCheckInput,
  validateOutput as kernelValidateOutput,
  validateJsonOutput as kernelValidateJson,
  createSafetyMetrics,
  type SafetyCheckResult,
} from '@chrono/kernel';

export type { SafetyCheckResult };

/** 模块级安全指标单例（兼容现有消费方） */
export const safetyMetrics = createSafetyMetrics();

export function checkInputSafety(messages: readonly ChatMessage[]): SafetyCheckResult {
  return kernelCheckInput(messages, safetyMetrics);
}

export function validateOutput(response: ChatResponse): ChatResponse {
  return kernelValidateOutput(response, safetyMetrics);
}

export function validateJsonOutput(content: string): SafetyCheckResult {
  return kernelValidateJson(content);
}
