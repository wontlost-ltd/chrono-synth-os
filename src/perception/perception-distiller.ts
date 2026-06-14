/**
 * 感知蒸馏器（PerceptionDistiller）— 把感官老师的多模态分析变成可审计的成长材料（ADR-0051 Phase 1）。
 *
 * 类比 LlmReflectionDistiller：感官老师（PerceptionProvider）输出**不可信**，绝不直接改核心状态。
 * 本蒸馏器纯编排：
 *   ① 调老师 analyze(媒体表征) → PerceptionAnalysis（不可信）；
 *   ② 硬校验（丢弃畸形/越界/幻觉条目）；
 *   ③ 事实型观察 → 直接写 memory node（episodic/semantic）——只是新记忆，不改「我是谁」，低风险；
 *   ④ 同一媒体内多条事实之间 → memory_edge 候选交 DistillationService.ingest（链接真实记忆，满足门可自动）；
 *   ⑤ 身份层提案（value_shift / narrative_patch）→ 交蒸馏门，**默认 pending 人工审批**（改「我是谁」保守）。
 *
 * 不变量（「核」= 身份核：value 权重 / narrative / L0-L3 决策风格·认知模型 / 规则·模板）：
 *   - **绝不自动改身份核**：感知的 value_shift/narrative_patch 提案一律走蒸馏门且必 pending 人工审批
 *     （value_shift 因 patternAgrees=false 永不满足自动门；narrative_patch 门控默认 pending）。
 *   - 绝不调 CoreRhythmLayer 的身份写方法（updateValueParams/updateNarrative/setDecisionStyle 等）。
 *   - **会自动写的只有事实层**：事实型观察 append 为 memory node，相邻事实间 memory_edge 候选满足门
 *     （confidence≥0.75∧evidence≥2）会自动编译为记忆边——但**只链接刚写入的两条真实记忆**，不创造
 *     身份、不改 value/narrative，与 ADR-0047 既有 memory_edge 自动编译同属「仅链接真实记忆，安全」。
 *   - 蒸馏候选 source 用独立的 'perception'（v088 已扩 distilled_artifacts.source CHECK），与
 *     'knowledge_import'（读文档/导入知识库）区分血缘——溯源/审计时能分清一条候选源自「听了段
 *     经历」还是「读了篇文档」。感知 provenance 也体现在 memory content 第一人称「我听到/我看到」+
 *     evidence 指向真实记忆 id。
 *   - value_shift delta 进门前**封顶**到自动门上限（0.05），patternAgrees=false（感知单源，不冒充
 *     确定性 pattern 交叉验证）→ 故 value_shift 永远 pending，不会被感知单源自动改 value。
 *   - **老师调用失败**（analyze 抛错 / 空表征 / 分析畸形）安全降级为「未产记忆」，不抛进调用方主流程。
 *     记忆写入（memoryGraph.addMemory）与蒸馏门（distillation.ingest）是基础设施操作——其失败（如 DB
 *     不可用）按常规**抛出**由调用方处理，不静默吞（与 LlmReflectionDistiller 一致）。perceive 是
 *     **append 语义非事务**：若在写入多条记忆中途基础设施失败，已写入的记忆是有效真实感知（不回滚）。
 */

import type { Logger } from '../utils/logger.js';
import type { ArtifactEvidence } from '@chrono/kernel';
import type { CognitiveMemoryGraph } from '../core/memory-graph.js';
import type { DistillationService, IngestResult } from '../intelligence/distillation-service.js';
import type {
  PerceptionProvider, PerceptionInput, PerceptionAnalysis, PerceivedFact, PerceivedIdentityHint,
} from './perception-provider.js';

/** 感知 value_shift 提案的 delta 封顶（对齐 core-update-gate 自动门 |delta|≤0.05）。 */
const MAX_PERCEPTION_DELTA = 0.05;
/** 单次感知最多沉淀的事实记忆数（控写入 + 防老师刷屏）。 */
const MAX_FACTS = 8;
/** 事实摘要最大长度（防超长污染记忆图）。 */
const MAX_SUMMARY_LEN = 500;

export interface PerceptionDistillInput {
  readonly personaId: string;
  readonly tenantId: string;
  readonly media: PerceptionInput;
}

export interface PerceptionDistillResult {
  /** 写入的事实记忆 id。 */
  readonly memoryIds: readonly string[];
  /** 交蒸馏门的候选结果（memory_edge / 身份提案）。 */
  readonly candidates: readonly IngestResult[];
  /**
   * 感官老师调用失败（analyze 抛错）→ true。区别于「老师成功但没听出可记的事」（teacherFailed=false
   * + memoryIds 空）。供审计区分「试了但老师挂了」与「正常但无沉淀」——前者应记 failed 事件。
   */
  readonly teacherFailed: boolean;
}

export class PerceptionDistiller {
  constructor(
    private readonly provider: PerceptionProvider,
    private readonly memoryGraph: CognitiveMemoryGraph,
    private readonly distillation: DistillationService,
    private readonly logger?: Logger,
  ) {}

  /**
   * 感知一次：老师分析 → 校验 → 沉淀事实记忆 + memory_edge/身份候选过门。
   * 老师调用失败（analyze 抛错/空表征/畸形）降级为空结果；记忆写入/蒸馏门基础设施失败按常规抛出
   * （见文件头不变量 4）。
   */
  async perceive(input: PerceptionDistillInput): Promise<PerceptionDistillResult> {
    const outcome = await this.analyzeSafe(input.media);
    /* 老师抛错降级：空结果但标记 teacherFailed，供调用方记 failed 审计事件。 */
    if (outcome === 'teacher-failed') return { memoryIds: [], candidates: [], teacherFailed: true };
    /* 空表征 / 老师返回空：正常无沉淀（非失败）。 */
    if (!outcome) return { memoryIds: [], candidates: [], teacherFailed: false };
    const analysis = outcome;

    /* ② 校验：丢弃畸形事实，截断到上限。 */
    const facts = this.validFacts(analysis.facts);
    if (facts.length === 0) {
      this.logger?.info('PerceptionDistiller', '老师分析无有效事实，跳过');
      return { memoryIds: [], candidates: [], teacherFailed: false };
    }

    /* ③ 事实 → memory node（episodic/semantic）。 */
    const memoryIds: string[] = [];
    for (const fact of facts) {
      const node = this.memoryGraph.addMemory(fact.memoryKind, fact.summary, fact.valence, fact.salience);
      memoryIds.push(node.id);
    }
    this.logger?.info('PerceptionDistiller', `感知沉淀 ${memoryIds.length} 条记忆（${input.media.modality}）`);

    const candidates: IngestResult[] = [];
    /* provenance：以 media hash 为锚的证据。type 暂用 'memory'（指向刚写的真实记忆 id）。 */
    const evidence: ArtifactEvidence[] = memoryIds.slice(0, 3).map((id) => ({ type: 'memory', id, score: 0.7 }));

    /* ④ 同一媒体内相邻事实 → memory_edge 候选（链接真实记忆，安全；满足门可自动）。 */
    for (let i = 0; i + 1 < memoryIds.length; i++) {
      const r = this.distillation.ingest(input.personaId, {
        kind: 'memory_edge',
        source: 'perception',   /* 感知血缘：见文件头说明 */
        payload: {
          sourceId: memoryIds[i],
          targetId: memoryIds[i + 1],
          relation: 'co_perceived',
          strength: 0.6,
        },
        confidence: clamp01(analysis.confidence),
        evidence: [{ type: 'memory', id: memoryIds[i], score: 0.7 }, { type: 'memory', id: memoryIds[i + 1], score: 0.7 }],
      });
      candidates.push(r);
    }

    /* ⑤ 身份层提案 → 蒸馏门（默认 pending；value_shift 封顶 + patternAgrees=false → 必 pending）。 */
    for (const hint of analysis.identityHints ?? []) {
      const candidate = this.buildIdentityCandidate(hint, evidence, clamp01(analysis.confidence));
      if (!candidate) continue;
      const r = this.distillation.ingest(input.personaId, candidate);
      candidates.push(r);
      this.logger?.info('PerceptionDistiller', `身份提案 ${hint.kind} → status=${r.status}`);
    }

    return { memoryIds, candidates, teacherFailed: false };
  }

  /**
   * 调老师。区分三态：成功→PerceptionAnalysis；空表征→undefined（正常无输入）；analyze 抛错→
   * 'teacher-failed'（老师挂了，供审计记 failed 事件）。
   */
  private async analyzeSafe(media: PerceptionInput): Promise<PerceptionAnalysis | 'teacher-failed' | undefined> {
    if (!media.representation.trim()) return undefined;
    try {
      return await this.provider.analyze(media, { maxFacts: MAX_FACTS });
    } catch (err) {
      this.logger?.warn('PerceptionDistiller', `感官老师失败，降级跳过: ${err instanceof Error ? err.message : String(err)}`);
      return 'teacher-failed';
    }
  }

  /** 校验事实条目：摘要非空且不超长、kind 合法、valence∈[-1,1]、salience∈[0,1]。畸形整条丢弃。 */
  private validFacts(facts: readonly PerceivedFact[] | undefined): PerceivedFact[] {
    if (!Array.isArray(facts)) return [];
    const out: PerceivedFact[] = [];
    for (const f of facts) {
      if (!f || typeof f.summary !== 'string') continue;
      const summary = f.summary.trim();
      if (summary.length === 0 || summary.length > MAX_SUMMARY_LEN) continue;
      if (f.memoryKind !== 'episodic' && f.memoryKind !== 'semantic') continue;
      if (!inRange(f.valence, -1, 1) || !inRange(f.salience, 0, 1)) continue;
      out.push({ summary, memoryKind: f.memoryKind, valence: f.valence, salience: f.salience, timeRangeMs: f.timeRangeMs });
      if (out.length >= MAX_FACTS) break;
    }
    return out;
  }

  /**
   * 身份提案 → 蒸馏候选。value_shift：delta 封顶到自动门上限、patternAgrees=false（感知单源不冒充
   * 确定性交叉验证）→ 故 ingest 后必 pending。narrative_patch：原样交门（门对 narrative 默认 pending）。
   * 畸形提案返回 undefined 丢弃。
   */
  private buildIdentityCandidate(
    hint: PerceivedIdentityHint,
    evidence: readonly ArtifactEvidence[],
    confidence: number,
  ): { kind: 'value_shift' | 'narrative_patch'; source: 'perception'; payload: unknown; confidence: number; evidence: readonly ArtifactEvidence[] } | undefined {
    if (hint.kind === 'narrative_patch') {
      if (typeof hint.narrative !== 'string' || hint.narrative.trim().length === 0) return undefined;
      return { kind: 'narrative_patch', source: 'perception', payload: { narrative: hint.narrative.trim() }, confidence, evidence };
    }
    /* value_shift：需真实 valueId + 有限 delta。delta 封顶 + 与 suggested 自洽（current=0 占位无关门控）。 */
    if (typeof hint.valueId !== 'string' || hint.valueId.trim().length === 0) return undefined;
    if (typeof hint.delta !== 'number' || !Number.isFinite(hint.delta)) return undefined;
    const capped = Math.sign(hint.delta) * Math.min(Math.abs(hint.delta), MAX_PERCEPTION_DELTA);
    if (capped === 0) return undefined;
    /* current/suggested 占位：distiller 不持有当前 value 权重（那是 distillation 编译期的事），
     * 这里给一致的 current=0.5、suggested=0.5+capped 仅满足 schema delta 自洽；patternAgrees=false。 */
    const current = 0.5;
    return {
      kind: 'value_shift',
      source: 'perception',   /* 感知血缘：见文件头说明 */
      payload: {
        valueId: hint.valueId.trim(),
        currentWeight: current,
        suggestedWeight: clamp01(current + capped),
        delta: clamp01(current + capped) - current,
        patternAgrees: false,
      },
      confidence,
      evidence,
    };
  }
}

function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
