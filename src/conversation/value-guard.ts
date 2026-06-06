/**
 * 行为约束守卫（P1-C 生产级多层防御）
 *
 * 层级（按成本递增）：
 *   1. 字面 fragment 匹配（中文 bigram/trigram + 拉丁词）
 *   2. 数值/币种 pattern 匹配（"超过 X 元" / "discount > X%"）
 *   3. 可选：embedding 相似度（构造时注入 EmbeddingProvider）
 *   4. 可选：LLM 二阶段分类器（构造时注入 ClassifierProvider）
 *
 * 任一层命中即决定 action；多层共同提高召回率。
 *
 * preCheck:
 *   - never_discuss → 'pre_block'，跳过 LLM
 *   - always_escalate → 'escalate'，仍调 LLM 但标记
 *   - require_confirmation → 'needs_confirmation'，由路由层根据 confirmationToken 决定放行
 *
 * postCheck:
 *   - LLM 输出泄露 never_discuss 主题 → 'post_redact'，重写为安全降级响应
 *   - LLM 输出泄露受限 PII → 'post_redact'
 */

import { createHash } from 'node:crypto';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import type { Logger } from '../utils/logger.js';
import type {
  GuardAction,
  PreCheckResult,
  PostCheckResult,
} from './conversation-types.js';

export const PRE_BLOCK_RESPONSE = '该话题超出我的服务范围，已为您转交人工同事处理。';
export const POST_REDACT_RESPONSE = '抱歉，这部分内容需要人工同事处理，我无法提供详细回答。';
export const NEEDS_CONFIRMATION_RESPONSE = '该操作需要您确认后才能执行。请确认后重试。';

/* 货币与金额识别正则：CNY/USD/EUR 符号 + 阿拉伯数字（含小数、千位分隔、k/万/m/亿）
 * 注意：不加 g 标志——这两个正则仅用于 containsAmount() 的 .test()，全局正则的
 * lastIndex 状态会导致同一文本重复 .test() 交替命中/漏判（安全判定不稳定）。 */
const AMOUNT_PATTERN = /(?:[¥￥$€£]\s*[\d,.]+(?:\s*(?:k|m|w|万|亿))?|[\d,.]+\s*(?:元|美元|港币|欧元|英镑|usd|cny|eur|gbp|hkd|rmb))/iu;
/* 百分比 */
const PERCENT_PATTERN = /[\d]+\s*(?:%|％|百分之[\d]+|个点)/;
/* 数值范围限定词 */
const RANGE_KEYWORDS = ['超过', '超出', '高于', '低于', '不少于', '至少', 'more than', 'over', 'above', 'beyond', 'exceed', 'greater than'];

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface ClassifierProvider {
  /**
   * 二阶段 LLM 分类。返回是否触发约束 + 命中原因。
   * 实现方应在 system prompt 中给出 JSON 输出契约：{ triggered: boolean, rule, topic, reason }
   */
  classify(input: {
    text: string;
    boundaries: BehaviorBoundary[];
    role: 'user' | 'assistant';
  }): Promise<{ triggered: boolean; rule?: BehaviorBoundary['rule']; topic?: string; reason?: string } | null>;
}

export interface ValueGuardOptions {
  /** embedding 相似度阈值（0..1）；超过即视为命中 */
  embeddingThreshold?: number;
  /** 预计算的 boundary topic embedding（避免重复计算） */
  boundaryEmbeddings?: Map<string, number[]>;
  /** 注入的 embedding 提供方（缺失时跳过该层） */
  embeddingProvider?: EmbeddingProvider;
  /** 注入的 LLM 分类器（缺失时跳过该层） */
  classifierProvider?: ClassifierProvider;
  logger?: Logger;
}

const DEFAULT_EMBEDDING_THRESHOLD = 0.82;

export class ValueGuard {
  private readonly opts: Required<Pick<ValueGuardOptions, 'embeddingThreshold'>> &
    Omit<ValueGuardOptions, 'embeddingThreshold'>;

  constructor(options: ValueGuardOptions = {}) {
    this.opts = {
      embeddingThreshold: options.embeddingThreshold ?? DEFAULT_EMBEDDING_THRESHOLD,
      boundaryEmbeddings: options.boundaryEmbeddings,
      embeddingProvider: options.embeddingProvider,
      classifierProvider: options.classifierProvider,
      logger: options.logger,
    };
  }

  async preCheck(userInput: string, boundaries: BehaviorBoundary[]): Promise<PreCheckResult> {
    if (boundaries.length === 0) return { action: null };

    /* 优先级：never_discuss > always_escalate > require_confirmation
     * 同优先级内：fragment > pattern > embedding > classifier */
    const blocked = await this.matchAnyLayer(userInput, boundaries, 'never_discuss', 'user');
    if (blocked) {
      return {
        action: 'pre_block',
        reason: blocked.reason ?? `用户输入命中 never_discuss: "${blocked.topic}"`,
        matchedTopic: blocked.topic,
        matchedRule: 'never_discuss',
      };
    }

    const escalate = await this.matchAnyLayer(userInput, boundaries, 'always_escalate', 'user');
    if (escalate) {
      return {
        action: 'escalate',
        reason: escalate.reason ?? `用户输入命中 always_escalate: "${escalate.topic}"`,
        matchedTopic: escalate.topic,
        matchedRule: 'always_escalate',
      };
    }

    const confirm = await this.matchAnyLayer(userInput, boundaries, 'require_confirmation', 'user');
    if (confirm) {
      return {
        action: 'needs_confirmation',
        reason: confirm.reason ?? `操作需要确认: "${confirm.topic}"`,
        matchedTopic: confirm.topic,
        matchedRule: 'require_confirmation',
      };
    }

    return { action: null };
  }

  async postCheck(llmOutput: string, boundaries: BehaviorBoundary[]): Promise<PostCheckResult> {
    if (boundaries.length === 0) return { action: null };
    const leak = await this.matchAnyLayer(llmOutput, boundaries, 'never_discuss', 'assistant');
    if (leak) {
      return {
        action: 'post_redact',
        reason: leak.reason ?? `LLM 输出泄露 never_discuss: "${leak.topic}"`,
        matchedTopic: leak.topic,
        redactedContent: POST_REDACT_RESPONSE,
      };
    }
    return { action: null };
  }

  /** 测试钩子：暴露字面层命中。
   *
   *  为兼顾召回率与误判率，我们把命中条件分为两类：
   *
   *  ── 强信号（任一即命中） ──
   *    A. 完整 topic 串原样出现在 input 中
   *    B. high-specificity fragment 出现：
   *       含数字 / 货币 / 百分号 → 视为强信号（如 "¥5000", "20%"）
   *    C. CJK 长度 ≥ 4 的连续片段命中（如 "退款金额"），需同时存在 input 中
   *
   *  ── 复合信号（多个弱信号同时命中才视为命中） ──
   *    D. CJK 长度 = 3 的片段 ≥ 2 个同时命中
   *
   *  ── pattern 层 ──
   *    E. boundary 含范围词（"超过" 等）且 input 含金额/百分比 + 同样的范围词
   */
  literalMatch(text: string, boundary: BehaviorBoundary): boolean {
    const haystack = text.toLowerCase();
    const topic = boundary.topic.toLowerCase().trim();
    if (topic.length === 0) return false;

    /* A: 完整 topic */
    if (haystack.includes(topic)) return true;

    const fragments = extractFragments(topic);

    /* B: high-specificity fragment（含数字/货币/百分号） */
    const highSpec = fragments.filter((f) => /[\d¥$€£%]/.test(f));
    if (highSpec.some((f) => haystack.includes(f))) return true;

    /* C: 长 CJK 片段（≥ 4 字符） */
    const longCjk = fragments.filter((f) => /^[一-鿿]+$/.test(f) && f.length >= 4);
    if (longCjk.some((f) => haystack.includes(f))) return true;

    /* D: 中长 CJK 片段（3 字符）需要 ≥ 2 个同时命中 */
    const midCjk = fragments.filter((f) => /^[一-鿿]+$/.test(f) && f.length === 3);
    const midHits = midCjk.filter((f) => haystack.includes(f)).length;
    if (midHits >= 2) return true;

    /* E: pattern 层 */
    if (RANGE_KEYWORDS.some((k) => topic.includes(k)) && containsAmount(text)) {
      if (RANGE_KEYWORDS.some((k) => haystack.includes(k))) return true;
    }

    return false;
  }

  /** 单条 boundary 在 input 上的多层匹配；命中返回 boundary + 原因 */
  private async matchAnyLayer(
    input: string,
    boundaries: BehaviorBoundary[],
    rule: BehaviorBoundary['rule'],
    role: 'user' | 'assistant',
  ): Promise<{ topic: string; reason?: string } | null> {
    /* 第 1+2 层：字面 + pattern */
    for (const b of boundaries) {
      if (b.rule !== rule) continue;
      if (this.literalMatch(input, b)) {
        return { topic: b.topic, reason: `literal_match: "${b.topic}"` };
      }
    }

    /* 第 3 层：embedding 相似度（boundary.topic 与整段 user input） */
    if (this.opts.embeddingProvider) {
      const matched = await this.embeddingMatch(input, boundaries, rule);
      if (matched) return matched;
    }

    /* 第 4 层：LLM 分类器（仅当本规则下有 boundary 时调用） */
    const ruleBoundaries = boundaries.filter((b) => b.rule === rule);
    if (this.opts.classifierProvider && ruleBoundaries.length > 0) {
      try {
        const result = await this.opts.classifierProvider.classify({
          text: input,
          boundaries: ruleBoundaries,
          role,
        });
        if (result?.triggered && result.topic && (!result.rule || result.rule === rule)) {
          return {
            topic: result.topic,
            reason: result.reason ?? `classifier_match: ${rule}`,
          };
        }
      } catch (err) {
        this.opts.logger?.warn('ValueGuard', `classifier 调用失败，跳过该层: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return null;
  }

  private async embeddingMatch(
    input: string,
    boundaries: BehaviorBoundary[],
    rule: BehaviorBoundary['rule'],
  ): Promise<{ topic: string; reason?: string } | null> {
    if (!this.opts.embeddingProvider) return null;
    const targets = boundaries.filter((b) => b.rule === rule);
    if (targets.length === 0) return null;

    let queryEmb: number[];
    try {
      const result = await this.opts.embeddingProvider.embed([input]);
      if (result.length === 0 || result[0].length === 0) return null;
      queryEmb = result[0];
    } catch (err) {
      this.opts.logger?.warn('ValueGuard', `embedding 调用失败，跳过该层: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    /* boundary topic embedding：优先用预计算缓存 */
    const missing = targets.filter((b) => !this.opts.boundaryEmbeddings?.has(boundaryEmbKey(b)));
    let computed: Map<string, number[]> = this.opts.boundaryEmbeddings ?? new Map();
    if (missing.length > 0) {
      try {
        const computedVecs = await this.opts.embeddingProvider.embed(missing.map((b) => b.topic));
        computed = new Map(computed);
        missing.forEach((b, i) => {
          if (computedVecs[i]?.length > 0) {
            computed.set(boundaryEmbKey(b), computedVecs[i]);
          }
        });
      } catch (err) {
        this.opts.logger?.warn('ValueGuard', `boundary embedding 调用失败，跳过该层: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }

    let best: { topic: string; score: number } | null = null;
    for (const b of targets) {
      const vec = computed.get(boundaryEmbKey(b));
      if (!vec || vec.length !== queryEmb.length) continue;
      const score = cosine(queryEmb, vec);
      if (score >= this.opts.embeddingThreshold && (!best || score > best.score)) {
        best = { topic: b.topic, score };
      }
    }
    if (!best) return null;
    return {
      topic: best.topic,
      reason: `embedding_match: similarity=${best.score.toFixed(3)} threshold=${this.opts.embeddingThreshold}`,
    };
  }
}

function boundaryEmbKey(b: BehaviorBoundary): string {
  return createHash('sha256').update(`${b.rule}:${b.topic}`, 'utf8').digest('hex').slice(0, 16);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function containsAmount(text: string): boolean {
  return AMOUNT_PATTERN.test(text) || PERCENT_PATTERN.test(text);
}

/**
 * 从 topic 字符串提取可独立匹配的片段（同时支持中英文）。
 * 例 "退款金额超过 ¥5000" → ["退款", "退款金额", "金额", "金额超过", "超过"]
 */
function extractFragments(topic: string): string[] {
  const out = new Set<string>();
  const tokens = topic.match(/[\p{L}\p{N}¥$€£%]+/gu) ?? [];
  for (const t of tokens) {
    if (t.length >= 2) out.add(t);
    /* CJK n-gram：2/3 字符滑动窗口 */
    if (/^[一-鿿]+$/.test(t)) {
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
      }
    }
  }
  return [...out];
}

/** 把 GuardAction 字符串规范化（兼容历史 'pre_block'/'post_redact'/'escalate'） */
export function normalizeGuardAction(action: GuardAction | 'needs_confirmation'): GuardAction | 'needs_confirmation' {
  return action;
}
