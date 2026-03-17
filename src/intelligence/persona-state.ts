/**
 * PersonaState 编译器 — 薄适配器
 * compilePersonaState 依赖 CoreRhythmLayer（应用层），留在 src/
 * summarizeForPrompt 委托 kernel 纯函数
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { PersonaOSState } from '../types/personality-os.js';
import { summarizeForPrompt as kernelSummarize } from '@chrono/kernel';

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
  return kernelSummarize(state);
}
