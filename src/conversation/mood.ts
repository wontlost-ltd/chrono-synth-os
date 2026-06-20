/**
 * 数字人心情状态与确定性漂移（ADR-0056 类人化：情绪/心情）——确定性、零-LLM。
 *
 * 心情 = 二维数值状态（PAD 简化：valence 效价 + arousal 唤醒），会随对话/经历**确定性漂移**：
 *   - 事件漂移：每轮对话据情感信号（用户输入情感词 + 检索记忆均值 valence）小步漂移（有界）；
 *   - 时间回归：距上次更新越久越向基线（中性）回归——人的情绪会平复。
 * 表达调制（语气随心情变）在 companion-locale + offline-responder，本模块只算状态。
 *
 * 不是「真的感受」，是一个会变的内部数值决定语气。纯函数：相同输入（current + signal + elapsed）
 * → 相同新心情，可复现、零-LLM。
 */

import type { SupportedLocale } from '../i18n/locale-resolver.js';

/** 心情状态（二维）。 */
export interface Mood {
  /** 效价 [-1,1]：愉快↔不快。 */
  readonly valence: number;
  /** 唤醒 [0,1]：平静↔激动。 */
  readonly arousal: number;
}

/** 基线/默认心情：中性偏平静。新数字人、长时间无互动回归到此。 */
export const DEFAULT_MOOD: Mood = Object.freeze({ valence: 0, arousal: 0.3 });

/** 单轮 valence 最大漂移（有界，防一句话从狂喜到崩溃；同成长 delta 的克制思路）。 */
const MAX_VALENCE_STEP = 0.15;
/** 单轮 arousal 最大漂移。 */
const MAX_AROUSAL_STEP = 0.12;
/** 时间回归半衰期（ms）：距上次更新此时长，心情向基线靠拢一半。默认 6h（情绪自然平复）。 */
const REGRESSION_HALF_LIFE_MS = 6 * 60 * 60 * 1000;

function clamp(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : (lo + hi) / 2;
}
function clampStep(x: number, max: number): number {
  return Math.max(-max, Math.min(max, x));
}

/** 一轮对话的情感事件。 */
export interface MoodEvent {
  /** 情感信号 [-1,1]：正=愉快事件（用户开心/赞许/聊喜欢的），负=不快事件。 */
  readonly valenceSignal: number;
  /** 事件强度 [0,1]：越强 arousal 升越多（如感叹、强情绪词）。缺省按 |valenceSignal| 估。 */
  readonly intensity?: number;
}

/**
 * 心情确定性漂移：先时间回归（向基线），再事件漂移（有界小步）。纯函数、可复现。
 * @param current 当前心情
 * @param event 本轮情感事件
 * @param elapsedMs 距上次更新的毫秒（≥0；用于时间回归）
 */
export function updateMood(current: Mood, event: MoodEvent, elapsedMs: number): Mood {
  /* ① 时间回归：elapsed 越大越接近基线。decay = 0.5^(elapsed/halfLife) ∈ (0,1]，越小越回归。 */
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const decay = Math.pow(0.5, e / REGRESSION_HALF_LIFE_MS);
  const regressedValence = DEFAULT_MOOD.valence + (current.valence - DEFAULT_MOOD.valence) * decay;
  const regressedArousal = DEFAULT_MOOD.arousal + (current.arousal - DEFAULT_MOOD.arousal) * decay;

  /* ② 事件漂移：有界小步。 */
  const signal = clamp(event.valenceSignal, -1, 1);
  const intensity = clamp(event.intensity ?? Math.abs(signal), 0, 1);
  const valence = clamp(regressedValence + clampStep(signal * MAX_VALENCE_STEP, MAX_VALENCE_STEP), -1, 1);
  /* arousal：强情绪事件（任一方向）都提升唤醒，弱事件向基线回落（已由回归处理）。 */
  const arousal = clamp(regressedArousal + clampStep(intensity * MAX_AROUSAL_STEP, MAX_AROUSAL_STEP), 0, 1);

  return { valence, arousal };
}

/** 心情四象限标签（供选措辞）。中性区间宽，确保「没触发情绪」时仍是 neutral（零回归）。 */
export type MoodLabel = 'positive' | 'negative' | 'excited' | 'calm' | 'neutral';

/** 把心情数值分类为标签（确定性阈值）。 */
export function moodLabel(mood: Mood): MoodLabel {
  const v = clamp(mood.valence, -1, 1);
  const a = clamp(mood.arousal, 0, 1);
  if (v >= 0.35) return a >= 0.6 ? 'excited' : 'positive';
  if (v <= -0.35) return 'negative';
  if (a <= 0.2) return 'calm';
  return 'neutral';
}

/* ── 情感信号提取（确定性词典，中英）─────────────────────────────────── */

/** 中文正/负情感词（子串匹配）。 */
const ZH_POSITIVE: readonly string[] = [
  '开心', '高兴', '快乐', '喜欢', '太好了', '真棒', '点赞', '谢谢', '感谢', '幸福', '满意', '兴奋', '期待', '喜悦', '哈哈',
];
const ZH_NEGATIVE: readonly string[] = [
  '难过', '伤心', '生气', '讨厌', '好烦', '好累', '糟糕', '失望', '痛苦', '焦虑', '害怕', '崩溃', '郁闷', '孤独', '想哭',
];
/** 中文否定词（出现在情感词前缀附近则翻转极性）。 */
const ZH_NEGATORS = ['不', '没', '别', '无'];

/** 英文正/负情感词（**词边界**匹配，防 like⊂dislike、good⊂goodwill 误命中）。 */
const EN_POSITIVE: readonly string[] = [
  'happy', 'glad', 'love', 'great', 'awesome', 'thanks', 'thank you', 'wonderful', 'excited', 'nice', 'good', 'cool', 'yay', 'delighted',
];
const EN_NEGATIVE: readonly string[] = [
  'sad', 'angry', 'hate', 'annoyed', 'tired', 'terrible', 'awful', 'disappointed', 'anxious', 'scared', 'lonely', 'upset', 'depressed', 'dislike', 'unhappy',
];
/** 英文否定词。 */
const EN_NEGATORS = ['not', "don't", 'no', 'never', "isn't", "aren't", "won't", "can't"];

/** 累加器：每个情感命中贡献 ±1（否定翻转），同时计数（用于归一）。 */
interface HitAcc { net: number; count: number; }

/** 中文：某情感词命中，前 2 字窗口有否定词 → 翻转极性。 */
function zhHits(text: string, words: readonly string[], baseSign: 1 | -1, acc: HitAcc): void {
  for (const w of words) {
    let idx = text.indexOf(w);
    while (idx >= 0) {
      const before = text.slice(Math.max(0, idx - 2), idx);
      const negated = ZH_NEGATORS.some((n) => before.includes(n));
      acc.net += negated ? -baseSign : baseSign;
      acc.count += 1;
      idx = text.indexOf(w, idx + w.length);
    }
  }
}

/** 英文：词边界命中（单词或 thank you 双词）+ 前 2 token 否定 → 翻转。 */
function enHits(tokens: readonly string[], words: readonly string[], baseSign: 1 | -1, acc: HitAcc): void {
  for (let i = 0; i < tokens.length; i++) {
    const one = tokens[i];
    const two = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : '';
    if (!words.includes(one) && !words.includes(two)) continue;
    const negated = tokens.slice(Math.max(0, i - 2), i).some((t) => EN_NEGATORS.includes(t));
    acc.net += negated ? -baseSign : baseSign;
    acc.count += 1;
  }
}

/**
 * 从用户输入提取情感信号 [-1,1]（确定性词典，否定感知）。
 * 正命中 +1、负命中 −1，否定词翻转极性（「不开心」→负、「不讨厌」→正），按命中总数归一。
 * 无情感词 → 0（中性，不漂移）。中英词典都扫（英文按词边界，防 like⊂dislike 等词内误命中）。
 */
export function extractEmotionSignal(userInput: string, _locale: SupportedLocale): number {
  const text = userInput.toLowerCase();
  const acc: HitAcc = { net: 0, count: 0 };
  zhHits(text, ZH_POSITIVE, 1, acc);
  zhHits(text, ZH_NEGATIVE, -1, acc);
  const tokens = text.split(/[^a-z']+/).filter((t) => t.length > 0);
  enHits(tokens, EN_POSITIVE, 1, acc);
  enHits(tokens, EN_NEGATIVE, -1, acc);
  if (acc.count === 0) return 0;
  return clamp(acc.net / acc.count, -1, 1);
}
