/**
 * 性格原型目录（② 经典 4 象限——性格多样性的「出生模板」）。
 *
 * 现状：所有 persona 从 DEFAULT_DECISION_STYLE 出生（中庸单点）。本模块提供 4 个**预设性格原型**，
 * 每个是一套完整的 6 维 decision style 种子，按 structural-scorer 的真实行为语义设计（不是空想）：
 *   - 探索者 explorer：explorationBias↑ riskAppetite↑ deliberationDepth↓——大胆试新、果断。
 *   - 守护者 guardian：riskAppetite↓ lossAversion↑ deliberationDepth↑——谨慎、规避损失。
 *   - 分析师 analyst：deliberationDepth↑ regretSensitivity↑ timeHorizon↑——深思、远见、怕错。
 *   - 行动者 doer：deliberationDepth↓ riskAppetite↑ timeHorizon↓——快速行动、当下导向。
 *
 * 4 个原型在 6 维空间里刻意离得开（用 personalityDiversity 度量可验证 diversityScore 高）。
 * 与 ③ 随机初始化叠加：archetype 给「基准性格」，perturbDecisionStyle 加「个体扰动」——同原型也有
 * 个体差异，不同原型差异更大。纯数据 + 纯函数，零 LLM/IO。
 *
 * 扰动幅度建议（Codex 复审）：magnitude 0.1~0.2 = 同原型的个体差异（仍明显偏向该原型）；
 * 0.5+ = 强随机化（会冲淡原型特征，更接近无原型的全随机出生）。
 */

import type { DecisionStyle } from './decision-style-types.js';

/** 性格原型枚举。 */
export type PersonalityArchetype = 'explorer' | 'guardian' | 'analyst' | 'doer';

export const PERSONALITY_ARCHETYPES: readonly PersonalityArchetype[] = ['explorer', 'guardian', 'analyst', 'doer'];

/** 原型种子（不含 updatedAt——由调用方写入时间戳）。 */
type ArchetypeSeed = Omit<DecisionStyle, 'updatedAt'>;

/**
 * 4 原型的 6 维种子值。范围与 validateDecisionStyle 一致（5 维 [0,1]，lossAversion≥1，
 * deliberationDepth 1..5 整数）。值刻意拉开但不取极端（留扰动空间，且极端值不真实）。
 */
const ARCHETYPE_SEEDS: Readonly<Record<PersonalityArchetype, ArchetypeSeed>> = {
  /* 探索者：高探索、高风险、浅思（果断）、短中期、低损失厌恶。 */
  explorer: {
    riskAppetite: 0.8,
    timeHorizon: 0.4,
    explorationBias: 0.85,
    lossAversion: 1.3,
    deliberationDepth: 2,
    regretSensitivity: 0.25,
  },
  /* 守护者：低风险、高损失厌恶、深思、长期、高后悔敏感（规避会后悔的选择）。 */
  guardian: {
    riskAppetite: 0.2,
    timeHorizon: 0.7,
    explorationBias: 0.15,
    lossAversion: 3.0,
    deliberationDepth: 4,
    regretSensitivity: 0.75,
  },
  /* 分析师：中性风险、最深思、最长期、高后悔敏感、中等探索（重数据而非直觉冒进）。 */
  analyst: {
    riskAppetite: 0.45,
    timeHorizon: 0.85,
    explorationBias: 0.5,
    lossAversion: 2.2,
    deliberationDepth: 5,
    regretSensitivity: 0.7,
  },
  /* 行动者：高风险、最浅思（快）、最短期（当下）、低损失厌恶、低后悔敏感。 */
  doer: {
    riskAppetite: 0.75,
    timeHorizon: 0.2,
    explorationBias: 0.55,
    lossAversion: 1.2,
    deliberationDepth: 1,
    regretSensitivity: 0.2,
  },
};

/** 原型展示元数据（供 onboarding/API 让产品面渲染选择卡片；中文标签 + 一句话画像）。 */
export interface ArchetypeProfile {
  readonly archetype: PersonalityArchetype;
  readonly label: string;
  readonly description: string;
}

/**
 * 4 原型的展示画像（单一来源，与 ARCHETYPE_SEEDS 的设计语义一致）。API 直接 surface，避免在
 * 路由层重复描述文案。
 */
export const ARCHETYPE_PROFILES: readonly ArchetypeProfile[] = [
  { archetype: 'explorer', label: '探索者', description: '大胆试新、果断——高探索、高风险、浅思、短中期。' },
  { archetype: 'guardian', label: '守护者', description: '谨慎、规避损失——低风险、高损失厌恶、深思、长期。' },
  { archetype: 'analyst', label: '分析师', description: '深思、远见、重数据——最深思、最长期、高后悔敏感、中性风险。' },
  { archetype: 'doer', label: '行动者', description: '快速行动、当下导向——高风险、最浅思、最短期、低损失厌恶。' },
];

/**
 * 取某原型的 decision style 种子（写入给定时间戳）。纯函数。
 * 非法/未知原型抛错（避免出生一个无定义性格）。
 */
export function archetypeDecisionStyle(archetype: PersonalityArchetype, now: number): DecisionStyle {
  const seed = ARCHETYPE_SEEDS[archetype];
  if (!seed) throw new Error(`未知性格原型: ${archetype}`);
  return { ...seed, updatedAt: now };
}

/** 是否合法原型（运行时校验，供 API/配置防脏值）。 */
export function isPersonalityArchetype(v: unknown): v is PersonalityArchetype {
  return typeof v === 'string' && (PERSONALITY_ARCHETYPES as readonly string[]).includes(v);
}
