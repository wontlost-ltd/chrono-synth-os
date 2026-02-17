/**
 * PersonaState 编译器
 * 从 L0-L4 各层 Store 读取数据，组装为完整人格状态或 prompt-ready 文本摘要
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { PersonaOSState } from '../types/personality-os.js';

/** 从核心层编译完整的五层人格状态 */
export function compilePersonaState(core: CoreRhythmLayer): PersonaOSState {
  const state = core.getState();
  return {
    L0: state.survivalAnchors,
    L1: state.values,
    L2: state.decisionStyle,
    L3: state.cognitiveModel,
    L4: {
      memories: state.memories,
      edges: state.edges,
      narrative: state.narrative,
    },
  };
}

/** 将五层人格状态压缩为结构化提示词文本 */
export function summarizeForPrompt(state: PersonaOSState): string {
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
    `  归因风格=${c.attributionStyle.toFixed(2)} | 成长心态=${c.growthMindset.toFixed(2)}\n` +
    (beliefLines ? `  信念:\n${beliefLines}\n` : '') +
    (biasLines ? `  偏误权重:\n${biasLines}` : ''),
  );

  /* L4 叙事摘要（不包含全部记忆，仅叙事） */
  if (state.L4.narrative) {
    sections.push(`## 自我叙事 (L4)\n  ${state.L4.narrative}`);
  }

  return sections.join('\n\n').trim();
}
