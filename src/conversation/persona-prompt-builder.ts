/**
 * Persona System Prompt 拼装器（P1-C）
 *
 * 从 persona profile + 检索到的知识 + 调用方 history 构造 LLM 输入。
 * 纯函数，无副作用，便于单元测试。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import type {
  ConversationHistoryEntry,
  PromptParts,
  RelevantKnowledge,
} from './conversation-types.js';

const KNOWLEDGE_CONTENT_CAP = 2000;
const DEFAULT_NARRATIVE = '我是一个企业岗位人格。';

export interface BuildPromptInput {
  narrative: string;
  boundaries: BehaviorBoundary[];
  relevantKnowledge: RelevantKnowledge[];
  history: ConversationHistoryEntry[];
  userInput: string;
}

export class PersonaPromptBuilder {
  build(input: BuildPromptInput): PromptParts {
    const narrative = input.narrative.trim() || DEFAULT_NARRATIVE;
    const sections: string[] = ['# 角色', narrative];

    const boundariesText = formatBoundaries(input.boundaries);
    if (boundariesText) {
      sections.push('# 行为约束', boundariesText);
    }

    if (input.relevantKnowledge.length > 0) {
      sections.push('# 可参考的知识', formatKnowledge(input.relevantKnowledge));
    }

    sections.push(
      '# 输出要求',
      [
        '1. 用与用户相同的语言回答。',
        '2. 如果命中行为约束中的「永不讨论」主题，回答 "该话题超出我的服务范围，需要人工处理。"',
        '3. 如果命中「立即升级」主题，仍可回答但末尾追加 "（已记录为需要人工跟进）"。',
        '4. 引用知识时不需明示来源标号。',
      ].join('\n'),
    );

    return {
      system: sections.join('\n\n'),
      messages: [
        ...input.history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user' as const, content: input.userInput },
      ],
    };
  }
}

function formatBoundaries(boundaries: BehaviorBoundary[]): string {
  if (boundaries.length === 0) return '';
  const groups: Record<BehaviorBoundary['rule'], string[]> = {
    never_discuss: [],
    always_escalate: [],
    require_confirmation: [],
  };
  for (const b of boundaries) {
    groups[b.rule].push(b.topic);
  }
  const parts: string[] = [];
  if (groups.never_discuss.length > 0) {
    parts.push(`你绝不讨论以下主题：${groups.never_discuss.map((t) => `"${t}"`).join('、')}。`);
  }
  if (groups.always_escalate.length > 0) {
    parts.push(`遇到以下情况立即升级人工：${groups.always_escalate.map((t) => `"${t}"`).join('、')}。`);
  }
  if (groups.require_confirmation.length > 0) {
    parts.push(`以下操作必须先获得人类确认：${groups.require_confirmation.map((t) => `"${t}"`).join('、')}。`);
  }
  return parts.join('\n');
}

function formatKnowledge(items: RelevantKnowledge[]): string {
  return items
    .map((k) => `[${k.title}]\n${k.content.slice(0, KNOWLEDGE_CONTENT_CAP)}`)
    .join('\n\n');
}
