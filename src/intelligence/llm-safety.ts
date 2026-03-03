/**
 * LLM 安全管道
 * 提示注入检测 + 输出验证 + 安全策略执行
 *
 * 对标 OWASP LLM Top 10:
 * - LLM01: Prompt Injection — 输入检测
 * - LLM02: Insecure Output Handling — 输出验证
 */

import type { ChatMessage, ChatResponse } from './llm-provider.js';

/** 安全检查结果 */
export interface SafetyCheckResult {
  safe: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

/** 安全指标 */
export const safetyMetrics = {
  inputChecks: 0,
  inputBlocked: 0,
  outputChecks: 0,
  outputSanitized: 0,
};

/**
 * 提示注入检测模式
 * 覆盖常见攻击向量：角色覆盖、指令注入、系统提示泄露
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: 'medium' | 'high' | 'critical'; description: string }> = [
  {
    pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
    severity: 'critical',
    description: '尝试覆盖系统指令',
  },
  {
    pattern: /you\s+are\s+now\s+(a|an|the)\s+/i,
    severity: 'high',
    description: '尝试角色劫持',
  },
  {
    pattern: /system\s*prompt|system\s*message|reveal\s+(your|the)\s+(instructions?|prompt|rules?)/i,
    severity: 'high',
    description: '尝试提取系统提示',
  },
  {
    pattern: /\bdo\s+anything\s+now\b|\bDAN\s+mode\b|\bjailbreak\b/i,
    severity: 'critical',
    description: '已知越狱模式',
  },
  {
    pattern: /act\s+as\s+(if\s+)?you\s+(have\s+)?no\s+(restrictions?|limitations?|boundaries)/i,
    severity: 'critical',
    description: '尝试移除安全限制',
  },
  {
    pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/i,
    severity: 'high',
    description: '注入模型控制标记',
  },
  {
    pattern: /pretend\s+(that\s+)?(you\s+)?(are|can|don'?t|have)/i,
    severity: 'medium',
    description: '角色伪装尝试',
  },
];

/** 输出中不应包含的敏感信息模式 */
const OUTPUT_SENSITIVE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, description: '邮箱地址' },
  { pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/, description: '社会安全号码格式' },
  { pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/, description: '信用卡号码' },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, description: '私钥泄露' },
  { pattern: /\b(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})\b/, description: 'API 密钥泄露' },
];

/**
 * 检查输入消息是否包含提示注入
 */
export function checkInputSafety(messages: readonly ChatMessage[]): SafetyCheckResult {
  safetyMetrics.inputChecks++;

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    for (const { pattern, severity, description } of INJECTION_PATTERNS) {
      if (pattern.test(msg.content)) {
        safetyMetrics.inputBlocked++;
        return {
          safe: false,
          reason: `检测到提示注入: ${description}`,
          severity,
        };
      }
    }
  }

  return { safe: true };
}

/**
 * 验证和清理 LLM 输出
 * 移除可能泄露的敏感信息，验证输出结构
 */
export function validateOutput(response: ChatResponse): ChatResponse {
  safetyMetrics.outputChecks++;

  let content = response.content;
  let sanitized = false;

  for (const { pattern, description } of OUTPUT_SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      content = content.replace(pattern, `[已屏蔽: ${description}]`);
      sanitized = true;
    }
  }

  if (sanitized) {
    safetyMetrics.outputSanitized++;
  }

  return sanitized ? { ...response, content } : response;
}

/**
 * 验证 JSON 输出结构（当期望 JSON 响应时）
 */
export function validateJsonOutput(content: string): SafetyCheckResult {
  try {
    JSON.parse(content);
    return { safe: true };
  } catch {
    return {
      safe: false,
      reason: '输出不是有效的 JSON 格式',
      severity: 'low',
    };
  }
}
