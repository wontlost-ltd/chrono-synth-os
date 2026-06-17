/**
 * PersonaState 摘要 — 纯领域逻辑
 * 将五层人格状态压缩为结构化文本
 * 零 node:* 依赖
 */

import type { SurvivalAnchor } from '../core-self/anchor-types.js';
import type { CoreValue } from '../core-self/value-types.js';
import type { DecisionStyle } from '../core-self/decision-style-types.js';
import type { CognitiveModel } from '../core-self/cognitive-model-types.js';

/** 可序列化的完整人格状态（L0-L4） */
export interface FullPersonaState {
  readonly L0: readonly SurvivalAnchor[];
  readonly L1: ReadonlyMap<string, CoreValue>;
  readonly L2: DecisionStyle;
  readonly L3: CognitiveModel;
  readonly L4: {
    readonly memories: ReadonlyMap<string, unknown>;
    readonly edges: readonly unknown[];
    readonly narrative: string;
  };
}

/** 将五层人格状态压缩为结构化提示词文本（纯函数） */
export function summarizeForPrompt(state: FullPersonaState): string {
  const sections: string[] = [];

  /* L0 生存锚点 */
  if (state.L0.length > 0) {
    const anchors = state.L0
      .map(a => `  - [${a.kind}] ${a.label} (严重度=${a.severity}): ${JSON.stringify(a.value)}`)
      .join('\n');
    sections.push(`## 底线约束 (L0)\n${anchors}`);
  }

  /* L1 价值函数 */
  if (state.L1.size > 0) {
    const values = [...state.L1.values()]
      .sort((a, b) => b.weight - a.weight)
      .map(v => `  - ${v.label}: ${v.weight.toFixed(2)} (时间折扣=${v.timeDiscount.toFixed(2)}, 情绪放大=${v.emotionAmplifier.toFixed(2)})`)
      .join('\n');
    sections.push(`## 核心价值 (L1)\n${values}`);
  }

  /* L2 决策风格 */
  const d = state.L2;
  sections.push(
    `## 决策风格 (L2)\n` +
    `  风险偏好=${d.riskAppetite.toFixed(2)} | ` +
    `时间视野=${d.timeHorizon.toFixed(2)} | ` +
    `探索偏好=${d.explorationBias.toFixed(2)}\n` +
    `  损失厌恶=${d.lossAversion.toFixed(2)} | ` +
    `审慎深度=${d.deliberationDepth} | ` +
    `后悔敏感=${d.regretSensitivity.toFixed(2)}`,
  );

  /* L3 认知模型 */
  const c = state.L3;
  const beliefLines = [...c.beliefs.entries()]
    .map(([k, v]) => `    ${k}: ${v.toFixed(2)}`)
    .join('\n');
  const biasLines = [...c.biasWeights.entries()]
    .map(([k, v]) => `    ${k}: ${v.toFixed(2)}`)
    .join('\n');
  sections.push(
    `## 认知模型 (L3)\n` +
    `  归因风格=${c.attributionStyle.toFixed(2)} | 成长心态=${c.growthMindset.toFixed(2)} | ` +
    `模糊容忍=${c.ambiguityTolerance.toFixed(2)} | 直觉↔分析=${c.analyticalIntuitive.toFixed(2)}\n` +
    (beliefLines ? `  信念:\n${beliefLines}\n` : '') +
    (biasLines ? `  偏误权重:\n${biasLines}` : ''),
  );

  /* L4 叙事摘要 */
  if (state.L4.narrative) {
    sections.push(`## 自我叙事 (L4)\n  ${state.L4.narrative}`);
  }

  return sections.join('\n\n').trim();
}
