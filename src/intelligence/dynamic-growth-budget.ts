/**
 * 动态成长预算（ADR-0048 成长治理 + ADR-0047）——确定性、零-LLM。
 *
 * 不确定性预算（窗口内自动编译的未验证成长上限）**随人格成熟度自适应**，而非静态配置：
 * U 形曲线——婴儿期（知识稀少）激进、成熟期（知识丰富）保守。
 *
 * 设计直觉（类比人类）：
 *   - 一张白纸需要大量输入才能形成人格，此时核心未定型、没什么可被侵蚀 → 高开放度。
 *   - 成熟人格核心已稳定，新输入要更谨慎，避免一句话改变三观 → 低开放度。
 *
 * 关键：看的是「相对核心的侵蚀比例」而非绝对条数——
 *   绝对预算随核心规模 M 缓增（有判断力了能多吸收），但**相对核心的侵蚀比例单调下降**
 *   （M↑ → 单窗口能动的核心占比↓），故成熟人格不被单日输入动摇。
 *
 * 纯函数：相同 M（+ 相同参数）→ 相同预算。无随机、无时钟、可复现、零-LLM。
 */

import { DEFAULT_DECISION_STYLE } from '@chrono/kernel';

/** 动态预算参数（可被 archetype 激进度调节：explorer 调高 openRatioMax/ceil，guardian 调低）。 */
export interface DynamicGrowthBudgetParams {
  /** 保底：再保守也至少能学这么多（否则全新白纸 M=0 算出 0 → 永远学不动）。 */
  readonly floor: number;
  /** 上限：封顶防失控（绝对预算不超过此值）。 */
  readonly ceil: number;
  /** M→0 时的开放度上限（如 2.0 = 婴儿期一天能学近翻倍核心规模）。 */
  readonly openRatioMax: number;
  /** 开放度衰减半衰点（M=halfMemories 时 openRatio 减半）。M 越大开放度越低。 */
  readonly halfMemories: number;
}

/** 默认参数（与 docs/self-learning-stop-logic.md 量化建议一致；中性 archetype）。 */
export const DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS: DynamicGrowthBudgetParams = Object.freeze({
  floor: 3,
  ceil: 30,
  openRatioMax: 2.0,
  halfMemories: 200,
});

/**
 * 按核心记忆数 M 算当前不确定性预算（U 形，确定性）。
 *   openRatio(M) = openRatioMax × halfMemories / (halfMemories + M)   —— 随 M 单调衰减
 *   budget       = clamp(floor, ceil, round(M × openRatio(M)))
 *
 * @param coreMemoryCount 当前核心记忆数（成熟度主指标，≥0）
 */
export function computeDynamicGrowthBudget(
  coreMemoryCount: number,
  params: DynamicGrowthBudgetParams = DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS,
): number {
  /* 防御非有限/负数（NaN/负 → 视为 0，回退 floor）。 */
  const m = Number.isFinite(coreMemoryCount) && coreMemoryCount > 0 ? coreMemoryCount : 0;
  /* 参数归一化（Codex 复审）：非法参数不应产出 NaN/异常预算。floor/ceil 取整为非负整数
   * （预算是条数，不该是小数）；ceil<floor 或非有限 → 用默认；halfMemories≤0 → 用默认（防除零/负衰减）。 */
  const floor = Number.isFinite(params.floor) && params.floor >= 0 ? Math.floor(params.floor) : DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.floor;
  const ceil = Number.isFinite(params.ceil) && params.ceil >= floor ? Math.floor(params.ceil) : Math.max(floor, DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.ceil);
  const halfM = Number.isFinite(params.halfMemories) && params.halfMemories > 0 ? params.halfMemories : DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.halfMemories;
  const openRatioMax = Number.isFinite(params.openRatioMax) && params.openRatioMax >= 0 ? params.openRatioMax : DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.openRatioMax;

  const openRatio = openRatioMax * halfM / (halfM + m);
  const raw = Math.round(m * openRatio);
  return Math.max(floor, Math.min(ceil, raw));
}

/* ── 成长激进度（按性格调制动态预算曲线，ADR-0048）─────────────────────── */

/** decision style 中与「成长激进度」相关的两维（爱探索+敢冒险 = 学得激进；规避 = 保守）。 */
interface AggressivenessSignals {
  readonly explorationBias: number;
  readonly riskAppetite: number;
}

/** clamp 到 [0,1]。 */
function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5;
}

/**
 * 从人格的 decision style 派生「成长激进度」∈[0,1]（确定性）。
 * 不依赖 archetype 标签（标签未持久化）——直接用已落库的 explorationBias + riskAppetite：
 *   explorer（exp0.85/risk0.8）→ ≈0.82 激进；guardian（risk0.2）→ ≈0.3 保守；默认 ≈0.5 中性。
 * 对扰动出生/演化/恢复快照的 persona 都生效（它们都有 decision style）。
 */
export function growthAggressivenessFromDecisionStyle(style: AggressivenessSignals): number {
  return clamp01((clamp01(style.explorationBias) + clamp01(style.riskAppetite)) / 2);
}

/** 中性锚点 = 默认 decision style（DEFAULT_DECISION_STYLE）派生的激进度——从 kernel 默认常量推导
 * （不硬编码 0.4，防 DEFAULT_DECISION_STYLE 漂移时此处不同步，Codex 复审）。
 * 该激进度必须映射回 DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS，保证「有/无默认 decision_style row」
 * 的默认人格预算一致（既有 persona 不突变）。 */
export const NEUTRAL_AGGRESSIVENESS = growthAggressivenessFromDecisionStyle(DEFAULT_DECISION_STYLE);

/**
 * 激进度 → 动态预算参数（确定性）：激进度只调**曲线高低**（openRatioMax/ceil），不动 floor（保底=3）
 * 与 halfMemories（衰减半衰点=200，成熟度形状对所有性格一致）。
 *
 * **锚定中性点**：aggr=NEUTRAL_AGGRESSIVENESS(0.4) → 恰好 DEFAULT_PARAMS（openRatioMax2.0/ceil30）——
 * 默认人格无突变。从中性点两侧线性偏移：
 *   openRatioMax = 2.0 + (aggr − 0.4) × SLOPE_OPEN   （aggr0.4→2.0，越激进越高）
 *   ceil         = round(30 + (aggr − 0.4) × SLOPE_CEIL）
 * SLOPE 取使端点合理：aggr1→openRatioMax≈2.8/ceil≈45，aggr0→openRatioMax≈1.47/ceil≈20。
 * 这样「U 形随成熟度」不变，曲线高低随性格，且默认人格（aggr=0.4）落在 DEFAULT_PARAMS。
 */
export function paramsForAggressiveness(aggressiveness: number): DynamicGrowthBudgetParams {
  const a = clamp01(aggressiveness);
  const d = a - NEUTRAL_AGGRESSIVENESS;
  /* 斜率：让 aggr 端点（0/1）落在合理保守/激进区间，且 aggr=NEUTRAL_AGGRESSIVENESS 精确等于 DEFAULT。 */
  const SLOPE_OPEN = 1.33;   // aggr1→2.0+0.6×1.33≈2.8；aggr0→2.0−0.4×1.33≈1.47
  const SLOPE_CEIL = 25;     // aggr1→30+0.6×25=45；aggr0→30−0.4×25=20
  return {
    floor: DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.floor,
    halfMemories: DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.halfMemories,
    openRatioMax: Math.max(0.5, DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.openRatioMax + d * SLOPE_OPEN),
    ceil: Math.max(DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.floor, Math.round(DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS.ceil + d * SLOPE_CEIL)),
  };
}
