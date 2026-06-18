/**
 * 主动消息文案生成（ADR-0054 Phase 3 — 确定性模板）。
 *
 * Phase 3 用第一人称确定性模板（零 LLM，相同信号 → 相同文案，可复现）。Phase 4 会接
 * OfflineConversationResponder 让文案据叙事/记忆更个性化——仍走「确定性生成」范式，不在
 * 运行时调 LLM（ADR-0054 红线 1）。
 */

import type { ProactiveSignalType } from '@chrono/kernel';

export interface ComposedNudge {
  readonly body: string;
  /** 消息类别（供客户端分组渲染）。 */
  readonly kind: string;
}

/** 各信号类型的第一人称主动开口模板（确定性）。 */
const TEMPLATES: Readonly<Record<ProactiveSignalType, ComposedNudge>> = {
  'core:memory-consolidated': {
    body: '我刚刚把最近的一段经历好好想了想，感觉自己更明白它对我意味着什么了。',
    kind: 'memory',
  },
  'core:narrative-changed': {
    body: '我发现自己最近有些变化——对「我是谁」的理解又清晰了一点，想跟你说一声。',
    kind: 'narrative',
  },
  'system:evolution-completed': {
    body: '我好像又成长了一点。回头看，我和不久前的自己已经有些不一样了。',
    kind: 'growth',
  },
};

/** 据信号类型生成确定性主动文案。 */
export function composeNudge(signalType: ProactiveSignalType): ComposedNudge {
  return TEMPLATES[signalType];
}
