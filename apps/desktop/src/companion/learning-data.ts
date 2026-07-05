/**
 * 桌面版「LLM 老师学习」数据层（ADR-0047「LLM 当老师」C 端）。
 *
 * 三块能力（成长期用 LLM 老师；运行时 chat 仍零-LLM）：
 *   - LLM 老师接入配置：GET/PUT/DELETE /companion/me/llm-settings（3 模式：BYOK key / 自定义端点 /
 *     ollama）。
 *   - 自主学习（反思）：POST /companion/me/reflect —— 让数字人反思已学记忆自我内化成长。
 *   - 喂料学习（感知）：POST /companion/me/perceive —— 喂一段文本/转写，LLM 老师解读→蒸馏门→
 *     沉淀为记忆。
 *
 * 全经内嵌 sidecar（apiFetch sidecar-first + 握手头，红线 11）。desktop apiFetch 不解包信封，取 .data。
 */

import { apiFetch } from '@/bridge/http-client';

/* ── LLM 老师接入配置 ─────────────────────────────────────────────── */

export type LlmProvider = 'openai' | 'anthropic' | 'ollama';

export interface LlmSettings {
  readonly activeProvider: string;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly hasApiKey: boolean;
  readonly canStoreApiKey: boolean;
  readonly globalProvider: string;
}

export interface LlmSettingsInput {
  readonly provider: LlmProvider;
  /** 空串=清除覆盖。 */
  readonly model?: string;
  /** 空串=清除（回官方/默认端点）。 */
  readonly baseUrl?: string;
  /** 非空=存 key；空串=撤销 key；省略=不动。 */
  readonly apiKey?: string;
}

export async function getLlmSettings(): Promise<LlmSettings> {
  const env = await apiFetch<{ data?: LlmSettings }>('/api/v1/companion/me/llm-settings');
  const d = env?.data;
  if (!d) throw new Error('读取 LLM 设置失败');
  return d;
}

export async function putLlmSettings(input: LlmSettingsInput): Promise<void> {
  await apiFetch('/api/v1/companion/me/llm-settings', { method: 'PUT', body: input });
}

export async function resetLlmSettings(): Promise<void> {
  await apiFetch('/api/v1/companion/me/llm-settings', { method: 'DELETE' });
}

/* ── 自主学习（反思）─────────────────────────────────────────────── */

export interface ReflectResult {
  readonly candidatesIngested: number;
  /** 直接自动编译进内核的成长候选数。 */
  readonly compiled?: number;
  /** 待人工审批的成长候选数（如改「我是谁」的叙事补丁）。 */
  readonly pending?: number;
  /** 无材料/无价值内核等短路原因。 */
  readonly reason?: string;
}

export async function reflect(): Promise<ReflectResult> {
  const env = await apiFetch<{ data?: ReflectResult }>('/api/v1/companion/me/reflect', { method: 'POST' });
  return env?.data ?? { candidatesIngested: 0 };
}

/* ── 喂料学习（感知）─────────────────────────────────────────────── */

/** 感知模态——服务端只认 audio/video 两种（representation 是转写/描述，服务端绝不接原始媒体二进制）。
 * 桌面喂料：文字材料/听到的内容 → 'audio'（转写）；看到的场景/图片描述 → 'video'（描述）。 */
export type PerceiveModality = 'audio' | 'video';

export interface PerceivedMemory {
  readonly id: string;
  readonly content: string;
  readonly valence: number;
  readonly salience: number;
}

export interface PerceiveResult {
  readonly perceivedMemories: readonly PerceivedMemory[];
  /** 'teacher'=真 LLM 老师解读；'deterministic'=无 key 的确定性回退（透明区分，不把 mock 当真老师）。 */
  readonly perceivedBy: 'teacher' | 'deterministic';
}

/** 表征长度上限（对齐服务端 PERCEIVE_REPRESENTATION_MAX_LEN）。 */
export const PERCEIVE_MAX_LEN = 4000;

export async function perceive(modality: PerceiveModality, representation: string): Promise<PerceiveResult> {
  const env = await apiFetch<{ data?: PerceiveResult }>('/api/v1/companion/me/perceive', {
    method: 'POST',
    body: { modality, representation },
  });
  const d = env?.data;
  if (!d) throw new Error('感知失败');
  return { perceivedMemories: d.perceivedMemories ?? [], perceivedBy: d.perceivedBy ?? 'deterministic' };
}
