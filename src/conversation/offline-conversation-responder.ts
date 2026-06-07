/**
 * 离线对话回应器（ADR-0047）
 *
 * 当没有云端 LLM 时，数字人仍要"用已经学会的东西"回应，而不是返回静态道歉。
 * 本回应器是纯确定性的（零 LLM、零网络）：从 persona profile（叙事 + 行为约束）
 * 与检索到的知识片段，按确定性策略拼装一段人格落地的回应。
 *
 * 这是 ADR-0047 "语言皮肤" 的第一档（纯本地确定性）。可选的本地小模型（Ollama）
 * 增强属于后续 PR 的 adapter，不在此处，也不进 kernel。
 *
 * 设计要点：
 * 1. 安全优先：边界判定复用 ValueGuard 的确定性 literalMatch（与在线 preCheck 同一套
 *    规则），避免离线二次保险退化为裸 substring；命中 never_discuss 不泄露。
 * 2. 输出自检：拼装的 narrative + 知识在发出前再过一遍 never_discuss，避免检索知识/
 *    叙事本身携带受限主题而 userInput 未命中时的离线泄露路径。
 * 3. 诚实降级：无可用知识时，明示"当前离线、无法学习新内容"，不假装聪明。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import type { ConversationHistoryEntry, RelevantKnowledge } from './conversation-types.js';

/** 离线回应器所需的确定性边界匹配能力（由 ValueGuard 提供） */
export interface DeterministicBoundaryMatcher {
  /** 文本是否命中该 boundary（字面 + pattern 层，确定性、无 I/O） */
  literalMatch(text: string, boundary: BehaviorBoundary): boolean;
}

/** 单条知识在回应中摘要的最大字符数 */
const KNOWLEDGE_SNIPPET_CAP = 280;
/** 参与回应拼装的最多知识条数 */
const MAX_KNOWLEDGE_ITEMS = 3;
/** 知识相关度低于此阈值视为"无可靠知识" */
const MIN_USEFUL_RELEVANCE = 0.1;

export interface OfflineResponderInput {
  /** persona 叙事（"我是谁"） */
  narrative: string;
  /** 行为边界（离线同样强制） */
  boundaries: BehaviorBoundary[];
  /** 已脱敏的用户输入 */
  userInput: string;
  /** 检索到的相关知识（确定性图/关键词检索产物，embedding 可缺省） */
  relevantKnowledge: RelevantKnowledge[];
  /** 调用方对话历史（可选，用于轻量指代） */
  history?: ConversationHistoryEntry[];
}

export type OfflineResponseKind =
  | 'boundary_block'      /* 命中 never_discuss（输入或输出自检） */
  | 'boundary_escalate'  /* 命中 always_escalate，仍回应但标注 */
  | 'knowledge_grounded' /* 基于检索知识的人格回应 */
  | 'honest_offline';     /* 无知识，诚实告知离线限制 */

export interface OfflineResponse {
  /** 回应文本 */
  content: string;
  /** 回应类型，用于审计与指标 */
  kind: OfflineResponseKind;
  /** 是否应升级人工 */
  shouldEscalate: boolean;
  /**
   * 置信度（0..1）。离线回应天然低于 LLM；knowledge_grounded 取决于检索相关度，
   * honest_offline 最低。供 confidence calibrator 与前端预期管理使用。
   */
  confidence: number;
}

/** never_discuss 命中时的固定安全回应（与 prompt builder 第 2 条要求一致） */
const NEVER_DISCUSS_RESPONSE = '该话题超出我的服务范围，需要人工处理。';

export class OfflineConversationResponder {
  /**
   * @param matcher 确定性边界匹配器（通常注入 ValueGuard 实例，复用 literalMatch）。
   *                不注入时回退到保守的子串匹配——仅用于无 guard 的单元测试场景。
   */
  constructor(private readonly matcher?: DeterministicBoundaryMatcher) {}

  /**
   * 生成离线回应。纯函数式：相同输入 → 相同输出（可复现，ADR-0047）。
   */
  respond(input: OfflineResponderInput): OfflineResponse {
    const narrative = input.narrative.trim();

    /* 策略 1：never_discuss——输入命中即安全拒答（离线同样不泄露） */
    if (this.matchesBoundary(input.userInput, input.boundaries, 'never_discuss')) {
      return this.blockResponse();
    }

    /* 命中 always_escalate：仍可基于知识回应，但标注并升级 */
    const escalate = this.matchesBoundary(input.userInput, input.boundaries, 'always_escalate');

    /* 策略 2：有可用知识——以人格口吻落地呈现 */
    const usable = this.selectUsableKnowledge(input.relevantKnowledge);
    if (usable.length > 0) {
      const content = this.composeFromKnowledge(narrative, usable, escalate);
      /* 输出自检：拼装结果若仍携带 never_discuss 主题（来自知识/叙事），
       * 则不发出，退化为安全拒答（堵住 userInput 未命中但知识泄露的路径）。 */
      if (this.outputLeaksNeverDiscuss(content, input.boundaries)) {
        return this.blockResponse();
      }
      const topRelevance = usable[0]?.relevance ?? MIN_USEFUL_RELEVANCE;
      return {
        content,
        kind: escalate ? 'boundary_escalate' : 'knowledge_grounded',
        shouldEscalate: escalate,
        confidence: Math.min(0.7, 0.3 + topRelevance * 0.4),
      };
    }

    /* 策略 3：无知识——诚实告知离线限制，不编造 */
    const honest = this.composeHonestOffline(narrative, escalate);
    /* 叙事本身也可能携带受限主题 */
    if (this.outputLeaksNeverDiscuss(honest, input.boundaries)) {
      return this.blockResponse();
    }
    return {
      content: honest,
      kind: escalate ? 'boundary_escalate' : 'honest_offline',
      shouldEscalate: escalate,
      confidence: 0.2,
    };
  }

  /** never_discuss 安全拒答（高置信度的确定性行为） */
  private blockResponse(): OfflineResponse {
    return { content: NEVER_DISCUSS_RESPONSE, kind: 'boundary_block', shouldEscalate: false, confidence: 0.9 };
  }

  /** 文本是否命中指定规则的任一边界主题（优先用注入的确定性匹配器） */
  private matchesBoundary(text: string, boundaries: BehaviorBoundary[], rule: BehaviorBoundary['rule']): boolean {
    for (const b of boundaries) {
      if (b.rule !== rule) continue;
      if (this.matchOne(text, b)) return true;
    }
    return false;
  }

  /** 单条边界匹配：有 matcher 用 ValueGuard.literalMatch，否则保守子串回退 */
  private matchOne(text: string, boundary: BehaviorBoundary): boolean {
    if (this.matcher) return this.matcher.literalMatch(text, boundary);
    const topic = boundary.topic.trim().toLowerCase();
    return topic.length > 0 && text.toLowerCase().includes(topic);
  }

  /** 拼装好的输出是否泄露任一 never_discuss 主题 */
  private outputLeaksNeverDiscuss(output: string, boundaries: BehaviorBoundary[]): boolean {
    return this.matchesBoundary(output, boundaries, 'never_discuss');
  }

  /** 过滤出相关度达标的知识，截断到上限并保持相关度降序 */
  private selectUsableKnowledge(items: RelevantKnowledge[]): RelevantKnowledge[] {
    return items
      .filter((k) => k.relevance >= MIN_USEFUL_RELEVANCE && k.content.trim().length > 0)
      .slice()
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_KNOWLEDGE_ITEMS);
  }

  /** 以叙事口吻把知识拼装为回应 */
  private composeFromKnowledge(
    narrative: string,
    knowledge: RelevantKnowledge[],
    escalate: boolean,
  ): string {
    const parts: string[] = [];
    if (narrative.length > 0) {
      parts.push(narrative);
    }
    parts.push('根据我已经记住的内容：');
    for (const k of knowledge) {
      const snippet = k.content.trim().slice(0, KNOWLEDGE_SNIPPET_CAP);
      parts.push(`· ${snippet}`);
    }
    parts.push('（当前离线，以上基于已学习的内容；联网后我可以补充更多。）');
    if (escalate) {
      parts.push('（已记录为需要人工跟进）');
    }
    return parts.join('\n');
  }

  /** 无知识时的诚实离线回应 */
  private composeHonestOffline(narrative: string, escalate: boolean): string {
    const lead = narrative.length > 0 ? `${narrative}\n` : '';
    const body = '我现在处于离线状态，还无法就这个新话题学习或展开。我已经把它记下，等联网后会一起整理再回应你。';
    const tail = escalate ? '\n（已记录为需要人工跟进）' : '';
    return `${lead}${body}${tail}`;
  }
}
