/**
 * 性格多样性度量（把「数字人群够不够多样」从体感变成可回归的数字）。
 *
 * 性格的可量化主维度是 decision style 的 6 个连续维度（riskAppetite/timeHorizon/explorationBias/
 * lossAversion/deliberationDepth/regretSensitivity）。本模块把一组 persona 的 decision style 向量
 * 先**归一化到 [0,1]**（各维量纲不同，不归一化会让 deliberationDepth/lossAversion 主导距离），再算
 * **平均成对欧氏距离 = 多样性分**（0=全同，→1=最分散）+ **每维 spread**（哪个维度驱动多样性）。
 *
 * 纯确定性、零 LLM/IO——同一组向量 → 同一组数字（可回归，跟 learning/retrieval benchmark 同思路）。
 *
 * 用途：度量一个租户/一批 fork 的性格离散度，验证「制造多样性」的机制（②原型/③随机初始化）是否真的
 * 拉开了性格分布——是它们的尺子。
 */

import type { DecisionStyle } from './decision-style-types.js';

/** 归一化 lossAversion 的参考尺度：(la-1)/((la-1)+REF) 饱和映射。
 * la=1→0、la=2→0.5、la=3→0.667，渐近 1——无上界维度压到 [0,1) 且保单调，不靠武断 clamp。 */
const LOSS_AVERSION_REF = 1;
/** deliberationDepth 范围 1..5（整数）。 */
const DELIBERATION_MIN = 1;
const DELIBERATION_MAX = 5;
/** 6 维向量——最大可能欧氏距离 = sqrt(6)（各维 [0,1]，两点分别全 0/全 1）。用于把距离归一到 [0,1]。 */
const DIM_COUNT = 6;
const MAX_DISTANCE = Math.sqrt(DIM_COUNT);

/** 归一化后的性格向量（6 维，各维 [0,1]）。维序固定，供距离/方差按位计算。 */
export interface NormalizedPersonalityVector {
  readonly riskAppetite: number;
  readonly timeHorizon: number;
  readonly explorationBias: number;
  readonly lossAversion: number;
  readonly deliberationDepth: number;
  readonly regretSensitivity: number;
}

/** 多样性度量结果。 */
export interface PersonalityDiversityResult {
  /** persona 数量。 */
  readonly count: number;
  /**
   * 多样性分 [0,1]：所有成对归一化欧氏距离的均值 / sqrt(6)。0=全同，越大越分散。
   * count<2 时为 0（无成对可比）。
   */
  readonly diversityScore: number;
  /** 每维 spread（归一化后该维的**总体标准差**，除以 n，[0,0.5]）——指出哪个维度驱动多样性。 */
  readonly perDimensionSpread: NormalizedPersonalityVector;
  /** 每维均值（归一化后）——群体性格画像（偏冒进还是保守等）。 */
  readonly perDimensionMean: NormalizedPersonalityVector;
}

/** 把单个 DecisionStyle 归一化到 6 维 [0,1] 向量。纯函数。 */
export function normalizePersonality(style: DecisionStyle): NormalizedPersonalityVector {
  return {
    /* 已是 [0,1]，直通（clamp 兜底防越界脏数据）。 */
    riskAppetite: clamp01(style.riskAppetite),
    timeHorizon: clamp01(style.timeHorizon),
    explorationBias: clamp01(style.explorationBias),
    regretSensitivity: clamp01(style.regretSensitivity),
    /* lossAversion ≥1 无上界 → 饱和映射到 [0,1)。 */
    lossAversion: normalizeLossAversion(style.lossAversion),
    /* deliberationDepth 1..5 → (d-1)/4 ∈ [0,1]。 */
    deliberationDepth: clamp01((style.deliberationDepth - DELIBERATION_MIN) / (DELIBERATION_MAX - DELIBERATION_MIN)),
  };
}

/**
 * 计算一组 persona 的性格多样性（纯函数）。空/单元素返回 diversityScore=0。
 */
export function personalityDiversity(styles: readonly DecisionStyle[]): PersonalityDiversityResult {
  const vectors = styles.map(normalizePersonality);
  const count = vectors.length;

  const mean = perDimension(vectors, (vals) => avg(vals));
  const spread = perDimension(vectors, (vals) => stddev(vals));

  /* 多样性分：所有成对欧氏距离均值 / sqrt(6)，归一到 [0,1]。
   * 收集所有成对距离后用 avg（排序求和）——使分值与输入顺序无关（浮点加法非结合律）。 */
  let diversityScore = 0;
  if (count >= 2) {
    const dists: number[] = [];
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        dists.push(euclidean(vectors[i], vectors[j]));
      }
    }
    diversityScore = dists.length > 0 ? clamp01(avg(dists) / MAX_DISTANCE) : 0;
  }

  return { count, diversityScore, perDimensionSpread: spread, perDimensionMean: mean };
}

/* ── 内部纯函数 ── */

/** 各维独立聚合（按 NormalizedPersonalityVector 的 6 个字段逐维取值，套用 reducer）。 */
function perDimension(
  vectors: readonly NormalizedPersonalityVector[],
  reducer: (vals: number[]) => number,
): NormalizedPersonalityVector {
  const dim = (key: keyof NormalizedPersonalityVector): number => reducer(vectors.map((v) => v[key]));
  return {
    riskAppetite: dim('riskAppetite'),
    timeHorizon: dim('timeHorizon'),
    explorationBias: dim('explorationBias'),
    lossAversion: dim('lossAversion'),
    deliberationDepth: dim('deliberationDepth'),
    regretSensitivity: dim('regretSensitivity'),
  };
}

function euclidean(a: NormalizedPersonalityVector, b: NormalizedPersonalityVector): number {
  const keys: Array<keyof NormalizedPersonalityVector> = [
    'riskAppetite', 'timeHorizon', 'explorationBias', 'lossAversion', 'deliberationDepth', 'regretSensitivity',
  ];
  let sumSq = 0;
  for (const k of keys) {
    const d = a[k] - b[k];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq);
}

function normalizeLossAversion(la: number): number {
  /* 脏数据兜底（Codex 复审）：非有限（NaN/±Infinity）或 ≤1 → 0；与 clamp01(NaN)→0 一致，绝不传播 NaN。 */
  if (!Number.isFinite(la) || la <= 1) return 0;
  const excess = la - 1; /* >0 */
  return excess / (excess + LOSS_AVERSION_REF); /* 饱和到 [0,1) */
}

/**
 * 平均值——**对值排序后再求和**，使结果与输入顺序无关（浮点加法不满足结合律，
 * 不排序时 [a,b,c] 与 [c,a,b] 会在末位 epsilon 上分叉，破坏「相同集合相同输出」的确定性）。
 */
function avg(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  return sorted.reduce((s, x) => s + x, 0) / sorted.length;
}

function stddev(vals: number[]): number {
  if (vals.length === 0) return 0;
  const m = avg(vals);
  return Math.sqrt(avg(vals.map((x) => (x - m) * (x - m))));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
