/**
 * 决策风格随机初始化（③ 性格多样性的「出生机制」）。
 *
 * 现状：所有从同一模板/默认出生的 persona 都用同一份 DEFAULT_DECISION_STYLE——出生即同质，
 * 多样性只能靠后天演化拉开。本模块在**出生时**给 6 维 decision style 加**可控、可复现**的随机扰动，
 * 让同源 persona 出生即略有不同（性格分布从一个点变成一团）。
 *
 * 关键设计：
 *   - **确定性**：扰动由 seed 字符串决定（同 seed → 同扰动）。零 LLM、零真随机源——用确定性 PRNG，
 *     符合 ADR-0047 可复现内核。seed 一般取 personaId（每个 persona 一份稳定扰动）。
 *   - **有界**：每维扰动 ±magnitude，且结果 clamp 回该维合法范围（不产越界脏数据）。
 *   - **magnitude 可控**：调用方给扰动幅度（0=不扰动=旧行为，向后兼容）。
 *
 * 用 personality-diversity 度量可验证：扰动后一批 persona 的 diversityScore > 0（出生即被拉开）。
 */

import type { DecisionStyle } from './decision-style-types.js';

/** 各维合法范围（与 validateDecisionStyle 一致）。deliberationDepth 是 1..5 整数。 */
const RISK_MIN = 0, RISK_MAX = 1;
const LOSS_AVERSION_MIN = 1; /* ≥1，无上界——扰动只向上不向下越界 */
const DELIBERATION_MIN = 1, DELIBERATION_MAX = 5;
/** 整数维（deliberationDepth）扰动缩放：float 维用 ±mag，整数维需更大缩放才能在 5 档整数上产生 ±1~2
 * 分散（mag=0.15、×10 时 base=3 → 分布 {2,3,4}）。×2（旧值）在 0.15 下 round 恒回 base，整数维不动。 */
const INT_DIM_SCALE = 10;

/**
 * 给 base decision style 加可复现随机扰动。
 *
 * @param base       基准风格（模板种子或 DEFAULT_DECISION_STYLE）
 * @param seed       扰动种子（同 seed → 同结果；一般用 personaId）
 * @param magnitude  扰动幅度（0..1，作用于 [0,1] 维的 ±幅度；0 = 不扰动）。其它维按各自量纲缩放。
 * @param now        生成时间戳（写入 updatedAt）
 */
export function perturbDecisionStyle(
  base: DecisionStyle,
  seed: string,
  magnitude: number,
  now: number,
): DecisionStyle {
  if (!(magnitude > 0)) {
    /* 0 或非法幅度 → 不扰动（向后兼容），仅更新时间戳。 */
    return { ...base, updatedAt: now };
  }
  const mag = Math.min(1, magnitude);
  /* 为每个维度派生一个独立的确定性 [-1,1] 抖动（seed+维名 → 哈希 → PRNG）。 */
  const jitter = (dim: string): number => signedUnit(hashSeed(`${seed}:${dim}`));

  /* [0,1] 维：base ± mag，clamp 回 [0,1]。 */
  const unit = (v: number, dim: string): number => clamp(v + jitter(dim) * mag, RISK_MIN, RISK_MAX);

  return {
    riskAppetite: unit(base.riskAppetite, 'riskAppetite'),
    timeHorizon: unit(base.timeHorizon, 'timeHorizon'),
    explorationBias: unit(base.explorationBias, 'explorationBias'),
    regretSensitivity: unit(base.regretSensitivity, 'regretSensitivity'),
    /* lossAversion（≥1 无上界）：base ± mag×参考幅度（1.0），向下 clamp 到 1。 */
    lossAversion: Math.max(LOSS_AVERSION_MIN, base.lossAversion + jitter('lossAversion') * mag * 1.0),
    /* deliberationDepth（1..5 整数）：base ± round(mag×INT_DIM_SCALE)，clamp 到 [1,5]。
     * mag=0 时 jitter×0×SCALE=0 → 恒等 base（向后兼容）。 */
    deliberationDepth: clampInt(
      Math.round(base.deliberationDepth + jitter('deliberationDepth') * mag * INT_DIM_SCALE),
      DELIBERATION_MIN, DELIBERATION_MAX,
    ),
    updatedAt: now,
  };
}

/* ── 确定性 PRNG（FNV-1a 哈希 → [0,1)）——纯函数，无依赖 ── */

/** FNV-1a 64-bit 哈希 → [0,1)。同字符串恒得同值（确定性）。64 位使扰动值空间从 ~4.3e9 提升到 ~1.8e19，
 * 大规模出生种子碰撞降到可忽略。纯 BigInt、无依赖；出生低频调用，BigInt 开销无关紧要。 */
function hashSeed(s: string): number {
  const MASK = 0xFFFFFFFFFFFFFFFFn;         // 64 位掩码
  const PRIME = 0x100000001b3n;             // FNV-1a 64 位 prime
  let h = 0xcbf29ce484222325n;              // FNV-1a 64 位 offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  /* 无符号 64 位 → [0,1)。2^64 = 18446744073709551616。 */
  return Number(h) / 18446744073709551616;
}

/** [0,1) → [-1,1]（对称抖动）。 */
function signedUnit(u: number): number {
  return u * 2 - 1;
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return v < min ? min : v > max ? max : v;
}

function clampInt(v: number, min: number, max: number): number {
  return clamp(Math.round(v), min, max);
}
