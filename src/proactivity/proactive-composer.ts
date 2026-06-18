/**
 * 主动消息文案生成（ADR-0054 Phase 4 — 据叙事/记忆个性化，仍零-LLM）。
 *
 * Phase 3 是纯静态模板；Phase 4 让文案据**人格叙事 + 触发信号内容**个性化（确定性字符串拼装，
 * 相同输入 → 相同文案，可复现）。**不在运行时调 LLM**（ADR-0054 红线 1）——更自然的话术若需要，
 * 仍走「LLM 当老师 → 蒸馏成确定性模板」范式（ADR-0047）。
 *
 * 无个性化上下文（拿不到叙事/记忆）→ 回退基线模板（与 Phase 3 一致），保证总有合理文案。
 */

import type { ProactiveSignalType } from '@chrono/kernel';

export interface ComposedNudge {
  readonly body: string;
  /** 消息类别（供客户端分组渲染）。 */
  readonly kind: string;
}

/** 个性化上下文（可选片段；缺省则回退基线模板）。来自只读人格状态。 */
export interface PersonalizationContext {
  /** persona 当前叙事（「我是谁」）——用于让 opener 带自我口吻。 */
  readonly narrative?: string;
  /** 触发信号关联的记忆/叙事内容片段（如刚巩固的记忆 content、新叙事）。 */
  readonly snippet?: string;
}

/** 各信号类型的基线第一人称模板（无个性化上下文时回退，等价 Phase 3）。 */
const BASE_TEMPLATES: Readonly<Record<ProactiveSignalType, ComposedNudge>> = {
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

/** 片段最大引用长度——避免把整段记忆/叙事原文复述出去（也降低敏感内容外泄面）。 */
const SNIPPET_CAP = 60;

/** 裁剪片段：去首尾空白、压缩内部空白、截断到上限并加省略号。 */
function trimSnippet(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s.length === 0) return '';
  return s.length > SNIPPET_CAP ? `${s.slice(0, SNIPPET_CAP)}…` : s;
}

/**
 * 据信号类型 + 个性化上下文生成确定性主动文案。
 * 有可用片段 → 个性化 opener（引用片段）；否则回退基线模板。
 */
export function composeNudge(signalType: ProactiveSignalType, ctx?: PersonalizationContext): ComposedNudge {
  const base = BASE_TEMPLATES[signalType];
  const snippet = ctx?.snippet ? trimSnippet(ctx.snippet) : '';
  if (snippet.length === 0) return base;

  switch (signalType) {
    case 'core:memory-consolidated':
      return { kind: base.kind, body: `我一直在回想「${snippet}」这件事，好像更明白它对我意味着什么了。` };
    case 'core:narrative-changed':
      return { kind: base.kind, body: `我最近对自己的理解又清晰了些——「${snippet}」，想跟你说一声。` };
    case 'system:evolution-completed':
      return { kind: base.kind, body: `我好像又成长了一点。现在的我会这样描述自己：「${snippet}」。` };
    default:
      return base;
  }
}
