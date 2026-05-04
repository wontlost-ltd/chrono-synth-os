/**
 * 行为约束守卫（P1-C MVP，关键词匹配）
 *
 * 模板的 behaviorBoundaries 存储于 persona_core.profile，
 * 由 PersonaTemplateService.instantiate 时写入。本模块在每次对话流水线中：
 *
 *   preCheck(userInput, boundaries)
 *     - never_discuss 命中 → action='pre_block'，跳过 LLM 调用，给出降级响应
 *     - always_escalate 命中 → action='escalate'，仍调 LLM 但标注 shouldEscalate
 *     - require_confirmation 命中 → action=null（仅写入 audit；prompt 中已有约束指令）
 *
 *   postCheck(llmOutput, boundaries)
 *     - never_discuss 主题在 LLM 输出中出现 → 重写为安全降级响应
 *
 * 实现：toLower + substring；后续可替换为 embedding 相似度。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import type { PreCheckResult, PostCheckResult } from './conversation-types.js';

export const PRE_BLOCK_RESPONSE = '该话题超出我的服务范围，需要人工处理。';
export const POST_REDACT_RESPONSE = '抱歉，这部分内容需要人工同事处理，我无法提供详细回答。';

export class ValueGuard {
  preCheck(userInput: string, boundaries: BehaviorBoundary[]): PreCheckResult {
    const haystack = userInput.toLowerCase();

    const blocked = findMatch(haystack, boundaries, 'never_discuss');
    if (blocked) {
      return {
        action: 'pre_block',
        reason: `用户输入命中 never_discuss 主题: "${blocked.topic}"`,
        matchedTopic: blocked.topic,
        matchedRule: 'never_discuss',
      };
    }

    const escalate = findMatch(haystack, boundaries, 'always_escalate');
    if (escalate) {
      return {
        action: 'escalate',
        reason: `用户输入命中 always_escalate 主题: "${escalate.topic}"`,
        matchedTopic: escalate.topic,
        matchedRule: 'always_escalate',
      };
    }

    return { action: null };
  }

  postCheck(llmOutput: string, boundaries: BehaviorBoundary[]): PostCheckResult {
    const haystack = llmOutput.toLowerCase();
    const leak = findMatch(haystack, boundaries, 'never_discuss');
    if (leak) {
      return {
        action: 'post_redact',
        reason: `LLM 输出命中 never_discuss 主题: "${leak.topic}"`,
        matchedTopic: leak.topic,
        redactedContent: POST_REDACT_RESPONSE,
      };
    }
    return { action: null };
  }
}

function findMatch(
  haystack: string,
  boundaries: BehaviorBoundary[],
  rule: BehaviorBoundary['rule'],
): BehaviorBoundary | undefined {
  for (const b of boundaries) {
    if (b.rule !== rule) continue;
    const needle = b.topic.toLowerCase().trim();
    if (needle.length === 0) continue;
    /* 提取每个 topic 中长度 ≥ 2 的中英文有意义片段做包含检查 */
    const fragments = extractFragments(needle);
    if (fragments.some((f) => haystack.includes(f))) {
      return b;
    }
  }
  return undefined;
}

/**
 * 把 topic 拆为可独立匹配的片段。
 * 例如 "退款金额超过 ¥5000" → ["退款金额超过", "¥5000"]
 * 拆分依据：连续的 CJK 文字、连续的字母数字、连续的非空白特殊字符。
 */
function extractFragments(topic: string): string[] {
  const matches = topic.match(/[\p{L}\p{N}¥$€£%]+/gu);
  if (!matches) return [topic];
  return matches.filter((m) => m.length >= 2);
}
