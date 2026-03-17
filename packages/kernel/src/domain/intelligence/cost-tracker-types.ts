/**
 * LLM 成本计算 — 纯领域逻辑
 * Token 定价模型与成本估算，零 node:* 依赖
 */

/** 成本记录（领域值对象） */
export interface CostRecord {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  timestamp: number;
}

/** 每 1K token 的美元价格 */
export interface TokenPrice {
  readonly input: number;
  readonly output: number;
}

/** 默认 token 定价表（每 1K token 美元价格，深度冻结） */
export const TOKEN_PRICES: Readonly<Record<string, TokenPrice>> = Object.freeze({
  'gpt-4o': Object.freeze({ input: 0.0025, output: 0.01 }),
  'gpt-4o-mini': Object.freeze({ input: 0.00015, output: 0.0006 }),
  'claude-sonnet-4-5-20250929': Object.freeze({ input: 0.003, output: 0.015 }),
  'claude-haiku-4-5-20251001': Object.freeze({ input: 0.0008, output: 0.004 }),
  'mock': Object.freeze({ input: 0, output: 0 }),
});

/** 未知模型的回退定价 */
export const FALLBACK_TOKEN_PRICE: TokenPrice = Object.freeze({ input: 0.001, output: 0.005 });

/** 安全截断 token 数量（非负有限整数） */
export function sanitizeTokenCount(tokens: number): number {
  if (!Number.isFinite(tokens)) return 0;
  return Math.max(0, Math.trunc(tokens) || 0);
}

/** 估算 LLM 调用成本（纯函数） */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number } {
  const safeInput = sanitizeTokenCount(inputTokens);
  const safeOutput = sanitizeTokenCount(outputTokens);
  const prices = TOKEN_PRICES[model] ?? FALLBACK_TOKEN_PRICE;
  const estimatedCostUsd = (safeInput / 1000) * prices.input + (safeOutput / 1000) * prices.output;
  const totalTokens = safeInput + safeOutput;
  return { inputTokens: safeInput, outputTokens: safeOutput, totalTokens, estimatedCostUsd };
}
