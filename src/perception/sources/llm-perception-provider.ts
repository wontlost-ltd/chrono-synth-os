/**
 * LLM 感官老师（LlmPerceptionProvider）— 用 LLM 把媒体表征翻成结构化感知分析（ADR-0051 Phase 2）。
 *
 * 这是 MockPerceptionProvider 的真实增量：当租户配了 LLM（BYOK，#97-99）时，用 ModelRouter 作
 * 「感官老师」做真语义理解——把一段经历（transcript / 场景描述）翻成人格视角的事实观察 + 可选
 * 身份层提案。**LLM 输出整体不可信**（与 LlmReflectionDistiller 同款）：本 provider 解析 + 硬校验，
 * 畸形/越界条目丢弃；LLM 错 / JSON 畸形 → 抛错（由 PerceptionDistiller.analyzeSafe 安全降级）。
 *
 * 论点（ADR-0051/0052）：LLM 只在**摄取阶段**（perceive route 内）被调一次，绝不进 runtime 决策；
 * 产物仍经蒸馏门，身份层提案默认 pending 人工审批——绝不自动改身份核。
 */

import type { LLMProvider } from '@chrono/kernel';
import { safeParseJson } from '@chrono/kernel';
import type {
  PerceptionProvider, PerceptionInput, PerceptionAnalyzeOptions, PerceptionAnalysis,
  PerceivedFact, PerceivedIdentityHint,
} from '../perception-provider.js';

const DEFAULT_MAX_FACTS = 5;
const MAX_SUMMARY_LEN = 500;

/** LLM 返回的不可信结构（进 PerceptionAnalysis 前硬校验）。 */
interface RawAnalysis {
  readonly facts?: unknown;
  readonly identityHints?: unknown;
  readonly confidence?: unknown;
}

export class LlmPerceptionProvider implements PerceptionProvider {
  readonly name = 'llm-perception';

  constructor(private readonly llm: LLMProvider) {}

  async analyze(input: PerceptionInput, options?: PerceptionAnalyzeOptions): Promise<PerceptionAnalysis> {
    const maxFacts = options?.maxFacts ?? DEFAULT_MAX_FACTS;
    const system = [
      '你是数字人格的「感官老师」。把用户交给人格的一段经历（已转写的文本表征）翻译成人格视角的',
      '结构化感知。只输出 JSON，不要任何额外文字。',
      '格式：{"facts":[{"summary":"人格第一人称事实摘要","memoryKind":"episodic|semantic","valence":-1到1,"salience":0到1}],',
      '"identityHints":[{"kind":"value_shift|narrative_patch","valueId":"(value_shift 必填，叙事补丁留空)","delta":-0.05到0.05,"narrative":"(narrative_patch 文本)","reason":"理由"}],',
      '"confidence":0到1}',
      `facts 最多 ${maxFacts} 条；identityHints 保守、宁缺勿滥（人格身份变化需谨慎）；summary 用第一人称如「我听到…」。`,
    ].join('\n');
    const user = `模态：${input.modality}\n经历表征：\n${input.representation}`;

    const res = await this.llm.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.3 },
    );
    const raw = safeParseJson<RawAnalysis>(res.content);
    if (!raw || typeof raw !== 'object') {
      throw new Error('LlmPerceptionProvider: LLM 返回非法 JSON');
    }

    /* 硬校验：facts/identityHints 逐条过滤，畸形丢弃。 */
    const facts = parseFacts(raw.facts, maxFacts);
    const identityHints = parseIdentityHints(raw.identityHints);
    const confidence = clamp01(typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0.6);

    return { facts, identityHints, confidence };
  }
}

function parseFacts(raw: unknown, maxFacts: number): PerceivedFact[] {
  if (!Array.isArray(raw)) return [];
  const out: PerceivedFact[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const f = r as Record<string, unknown>;
    const summary = typeof f.summary === 'string' ? f.summary.trim() : '';
    if (summary.length === 0 || summary.length > MAX_SUMMARY_LEN) continue;
    const memoryKind = f.memoryKind === 'semantic' ? 'semantic' : 'episodic';
    if (!inRange(f.valence, -1, 1) || !inRange(f.salience, 0, 1)) continue;
    out.push({ summary, memoryKind, valence: f.valence, salience: f.salience });
    if (out.length >= maxFacts) break;
  }
  return out;
}

function parseIdentityHints(raw: unknown): PerceivedIdentityHint[] {
  if (!Array.isArray(raw)) return [];
  const out: PerceivedIdentityHint[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const h = r as Record<string, unknown>;
    if (h.kind === 'value_shift') {
      if (typeof h.valueId !== 'string' || h.valueId.trim().length === 0) continue;
      if (typeof h.delta !== 'number' || !Number.isFinite(h.delta)) continue;
      out.push({ kind: 'value_shift', valueId: h.valueId.trim(), delta: h.delta, reason: asReason(h.reason) });
    } else if (h.kind === 'narrative_patch') {
      if (typeof h.narrative !== 'string' || h.narrative.trim().length === 0) continue;
      out.push({ kind: 'narrative_patch', narrative: h.narrative.trim(), reason: asReason(h.reason) });
    }
  }
  return out;
}

function asReason(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
