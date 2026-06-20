/**
 * 观点 / 不确定表达（ADR-0056 类人化：有立场、会迟疑）——确定性、零-LLM。
 *
 * 让数字人的回应「有态度」：grounding 弱时说「我记得好像…不太确定」（tentative），
 * 用户问评价类问题且有依据时说「我觉得 / 在我看来」（opinion），grounding 强的事实问答则
 * 直接自信回答（confident，无前缀＝零回归）。
 *
 * 关键：立场是对**已有信号的确定性投影**，不是新推理——
 *   - 不确定度 = grounding 强度（top relevance + 命中条数）的函数；
 *   - 观点 = 用户问的是不是评价类问题（确定性 locale 模式）∧ 有依据。
 * 相同 (opinionQuestion, topRelevance, count) → 相同 stance，可复现（论点保持）。
 */

import type { SupportedLocale } from '../i18n/locale-resolver.js';
import { companionLocale } from './companion-locale.js';

/** 回应立场。 */
export type Stance =
  | 'confident'   /* 有把握：强 grounding 的事实问答，直接答（无前缀，零回归） */
  | 'tentative'   /* 迟疑：grounding 弱（依据少/相关度低），坦诚不太确定 */
  | 'opinion';     /* 表态：用户问评价类问题且有依据，给「我觉得」式个人看法 */

/* 相关度阈值按检索的 score/(score+4) 饱和曲线标定：直接关键词命中通常落在 0.2~0.7，
 * 极少超过 0.7；图遍历邻居/边缘命中常 ＜0.1。
 * 设计：观点比事实更需要底气——人对观点会比陈述事实更谨慎地表态。 */
/** 事实问答算「弱」的相关度阈值（top relevance ＜ 此值 → 依据单薄，触发迟疑）。 */
const WEAK_RELEVANCE = 0.12;
/** 评价类问题敢给「我觉得」的高相关度门槛（单条达此值即可表态）。 */
const OPINION_STRONG_RELEVANCE = 0.5;

/** grounding 强度信号（由 responder 从 usable 知识算出后传入）。 */
export interface GroundingSignal {
  /** 最高相关度（0..1）。 */
  readonly topRelevance: number;
  /** 命中的可用知识条数。 */
  readonly count: number;
}

/**
 * 确定性判定回应立场。
 *  - 评价类问题 + **够底气**（多条印证 ≥2 条，或单条高相关 ≥0.5）→ opinion（我觉得）；
 *    评价类问题但依据单薄（仅 1 条且相关度一般）→ tentative（迟疑，不硬给没底气的观点）；
 *  - 事实问答 grounding 弱（无依据 / top relevance ＜ WEAK）→ tentative；
 *  - 其余（事实问答有依据）→ confident（无前缀，零回归）。
 */
export function classifyStance(opinionQuestion: boolean, grounding: GroundingSignal): Stance {
  const { topRelevance, count } = grounding;
  if (count <= 0) return 'tentative';
  if (opinionQuestion) {
    /* 观点需要底气：多条印证或单条高相关才敢表态，否则谨慎迟疑（诚实优先于嘴硬）。 */
    const confident = count >= 2 || topRelevance >= OPINION_STRONG_RELEVANCE;
    return confident ? 'opinion' : 'tentative';
  }
  if (topRelevance < WEAK_RELEVANCE) return 'tentative';
  return 'confident';
}

/** 用户输入是不是「评价/看法」类问题（你觉得X怎么样 / 你喜欢X吗 / X好不好）。 */
export function isOpinionQuestion(userInput: string, locale: SupportedLocale): boolean {
  const patterns = companionLocale(locale).opinionQuestionPatterns;
  const text = userInput.trim();
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}
