/**
 * GitHubResponseComposer — Plan 3 唯一的新领域逻辑（零-LLM 起草）。
 *
 * 基于数字人已学的 GitHub 记忆 + 一个 issue/PR 的上下文，**确定性起草**一条评论/review
 * 草稿。Task 5 端点调它。起草是纯文本拼装：**无 fetch / async / ModelRouter / LLM**——
 * 同输入同输出。LLM 老师是学习段 perceive 的事（喂料自成长），不在起草。
 *
 * 复用（DRY）：直接复用 OfflineConversationResponder 的拼装模式——把 issue/PR 标题+正文
 * 当"用户输入"（userInput），已学记忆当 relevantKnowledge，用同款 narrative lead +
 * top-3 grounded 记忆 + issue 上下文拼装。boundaries 传空数组（起草不涉及对外边界过滤，
 * 记忆来源已在学习段 perceive 时经蒸馏门控）。
 *
 * 诚实降级铁律：有相关记忆 → knowledge_grounded；无相关记忆（或全被相关度门槛过滤）→
 * honest_offline——数字人没学过就诚实说不知道，**不编造 review**。groundedCount 反映实际
 * 拼进草稿的记忆条数（与 OfflineConversationResponder 同款相关度门槛/top-N 一致）。
 */

import { OfflineConversationResponder } from '../../conversation/offline-conversation-responder.js';
import type { RelevantKnowledge } from '../../conversation/conversation-types.js';

/** 起草段唯一使用的响应类型（映射自 OfflineResponse.kind 的子集）。 */
export type DraftKind = 'knowledge_grounded' | 'honest_offline';

export interface DraftInput {
  /** persona 叙事（"我是谁"），作草稿 lead。 */
  narrative: string;
  /** 目标 issue/PR 标题（当 userInput 呼应）。 */
  targetTitle: string;
  /** 目标 issue/PR 正文（补进 userInput 上下文）。 */
  targetBody: string;
  /** 目标类型：issue 评论 or PR review。 */
  targetType: 'issue' | 'pull';
  /** 已学的相关记忆（确定性检索产物）。 */
  relevantKnowledge: RelevantKnowledge[];
}

export interface DraftResult {
  /** 起草的评论/review 草稿正文。 */
  body: string;
  /** knowledge_grounded=基于已学记忆；honest_offline=没学过、不编造。 */
  kind: DraftKind;
  /** 实际拼进草稿的记忆条数（相关度达标且计入 top-N）。 */
  groundedCount: number;
}

/** 直接命中相关度门槛（与 OfflineConversationResponder.MIN_USEFUL_RELEVANCE 同值）。 */
const MIN_USEFUL_RELEVANCE = 0.1;
/** 参与拼装的最多记忆条数（与 OfflineConversationResponder.MAX_KNOWLEDGE_ITEMS 同值）。 */
const MAX_KNOWLEDGE_ITEMS = 3;

/* 起草复用同一个无状态回应器实例（纯函数，无内部可变状态，可安全共享）。 */
const responder = new OfflineConversationResponder();

/**
 * 零-LLM 确定性起草：把 issue/PR 上下文当 userInput、已学记忆当 relevantKnowledge，
 * 复用 OfflineConversationResponder.respond 拼装草稿。相同输入 → 相同输出。
 */
export function composeGithubReply(input: DraftInput): DraftResult {
  /* issue/PR 标题+正文合成"用户输入"：标题作主呼应（拼进 lead-in），正文补上下文。
   * respond() 会把 userInput 喂给 knowledgeLeadIn，让草稿呼应 issue 标题。 */
  const userInput = composeUserInput(input.targetTitle, input.targetBody);

  const response = responder.respond({
    narrative: input.narrative,
    /* 起草不做对外边界过滤（记忆已在学习段经蒸馏门控），传空数组。 */
    boundaries: [],
    userInput,
    relevantKnowledge: input.relevantKnowledge,
  });

  /* respond() 返回的 kind 在无 boundaries 时只会是 knowledge_grounded / honest_offline。 */
  const kind: DraftKind = response.kind === 'knowledge_grounded' ? 'knowledge_grounded' : 'honest_offline';

  /* 草稿头：显式呼应正在回复的 issue/PR 标题——聊天里用户看得到自己的输入，GitHub 草稿则须
   * 在评论里点明所回复的对象（respond() 的 lead-in 只给固定措辞、不回显标题）。这一行是起草段
   * 相对通用对话的唯一差异，仍确定性（同标题同输出）。 */
  const header = composeHeader(input.targetTitle, input.targetType);

  return {
    body: `${header}\n${response.content}`,
    kind,
    /* groundedCount：与 respond() 同款选择逻辑算实际拼进草稿的记忆条数（门槛+top-N）。 */
    groundedCount: kind === 'knowledge_grounded' ? countUsableDirect(input.relevantKnowledge) : 0,
  };
}

/**
 * 草稿头：点明所回复的 issue/PR 标题。issue → 评论口吻，pull → review 口吻。
 * 标题为空时退化为不带标题的通用引子（仍确定性）。
 */
function composeHeader(title: string, targetType: 'issue' | 'pull'): string {
  const t = title.trim();
  const noun = targetType === 'pull' ? '这个 PR' : '这个 issue';
  if (t.length === 0) {
    return `关于${noun}：`;
  }
  return `关于${noun}「${t}」：`;
}

/**
 * 合成"用户输入"：标题在前（作 lead-in 呼应主体），正文换行补上下文。
 * 正文为空时只用标题——确定性，同输入同输出。
 */
function composeUserInput(title: string, body: string): string {
  const t = title.trim();
  const b = body.trim();
  return b.length > 0 ? `${t}\n${b}` : t;
}

/**
 * 与 OfflineConversationResponder.selectUsableKnowledge 的直接命中分支同款：
 * 过滤非空内容 + 相关度达标（≥0.1）+ 非联想（直接命中），截断到 top-N。返回实际计入条数。
 * 联想（isAssociation）仅作点缀、不单独成答，起草侧 groundedCount 只计直接命中（与草稿主体一致）。
 */
function countUsableDirect(items: RelevantKnowledge[]): number {
  const direct = items.filter(
    (k) => k.content.trim().length > 0 && !k.isAssociation && k.relevance >= MIN_USEFUL_RELEVANCE,
  );
  return Math.min(direct.length, MAX_KNOWLEDGE_ITEMS);
}
