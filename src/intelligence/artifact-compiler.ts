/**
 * 蒸馏工件编译器（ADR-0047 D3）
 *
 * 把 compiled 工件的载荷确定性地应用到核心状态——这是"LLM 蒸馏物 → 确定性内核"
 * 的最后一公里。纯确定性、零 LLM：编译器只翻译已审批工件的 payload 为对既有 core
 * store 的调用。
 *
 * 覆盖（与有干净 core API 的工件类型对应）：
 *   - value_shift        → CoreRhythmLayer.updateValueParams（权重）
 *   - memory_edge        → CoreRhythmLayer.linkMemories（记忆图边）
 *   - narrative_patch    → CoreRhythmLayer.updateNarrative（叙事重写）
 *   - response_template  → ResponseTemplateStore 专用持久表（版本化、不衰减）。
 *                          原先落 procedural 记忆会被衰减/驱逐（「学了会忘」），
 *                          违背蒸馏持久性，故 ADR-0047 改为专用表（需注入 templates）。
 *   - decision_style_patch → CoreRhythmLayer.setDecisionStyle（L2 决策风格参数校准，WP-1）
 *   - cognitive_model_patch → CoreRhythmLayer.setCognitiveModel（L3 认知模型参数校准，WP-1）
 *
 * 唯一尚不编译的 kind 是 rule：需独立的 rule-store + RuleEngine 持久入口（单列工作）。
 * 对它**显式拒绝并给原因**（不静默丢弃，D3：自我修改必须可解释），停留在 approved/pending。
 *
 * 快照/回滚由调用方（DistillationService）负责：它持有 ChronoSynthOS，能在编译
 * 批次前后做 snapshot 并在失败时 restore。编译器本身只报告每件工件的成败。
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { Logger } from '../utils/logger.js';
import type { ResponseTemplateStore } from '../storage/response-template-store.js';
import type { Clock } from '../utils/clock.js';
import type {
  DistilledArtifact,
  ValueShiftPayload,
  MemoryEdgePayload,
  ResponseTemplatePayload,
  DecisionStylePatchPayload,
  CognitiveModelPatchPayload,
} from '@chrono/kernel';

const LAYER = 'ArtifactCompiler';

export type CompileOutcome =
  | { readonly ok: true; readonly applied: string }
  | { readonly ok: false; readonly reason: string };

/** narrative_patch 载荷形状（kernel 未单列；编译器局部定义） */
interface NarrativePatchPayload {
  readonly narrative: string;
}

export class ArtifactCompiler {
  constructor(
    private readonly core: CoreRhythmLayer,
    private readonly logger?: Logger,
    /** response_template 专用持久表（ADR-0047）；未注入时该 kind 不可编译，显式失败。 */
    private readonly templates?: ResponseTemplateStore,
    private readonly clock?: Clock,
  ) {}

  /**
   * 编译单件工件到核心状态。调用方应仅对已通过校验且处于可编译状态的工件调用。
   * personaId 用于对象级落库（response_template 按 persona 持久化）。
   * 返回成败；失败不抛错（让上层按批次决定是否回滚）。
   */
  compile(personaId: string, artifact: DistilledArtifact): CompileOutcome {
    try {
      switch (artifact.kind) {
        case 'value_shift':
          return this.compileValueShift(artifact.payload as ValueShiftPayload);
        case 'memory_edge':
          return this.compileMemoryEdge(artifact.payload as MemoryEdgePayload);
        case 'narrative_patch':
          return this.compileNarrativePatch(artifact.payload as NarrativePatchPayload);
        case 'response_template':
          return this.compileResponseTemplate(personaId, artifact.id, artifact.payload as ResponseTemplatePayload);
        case 'decision_style_patch':
          return this.compileDecisionStylePatch(artifact.payload as DecisionStylePatchPayload);
        case 'cognitive_model_patch':
          return this.compileCognitiveModelPatch(artifact.payload as CognitiveModelPatchPayload);
        case 'rule':
          /* rule 持久化（规则库）尚未落地：需独立的 rule-store + RuleEngine 持久入口（单列工作）。
           * 显式拒绝并给原因，与 response_template「未注入则不可编译」同纪律——不静默吞。 */
          return { ok: false, reason: 'rule compilation not supported: persistent rule store not implemented yet' };
        default:
          return { ok: false, reason: `unsupported artifact kind for compile: ${artifact.kind}` };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger?.warn(LAYER, `编译失败 [${artifact.kind}] ${artifact.id}: ${reason}`);
      return { ok: false, reason };
    }
  }

  private compileValueShift(p: ValueShiftPayload): CompileOutcome {
    const updated = this.core.updateValueParams(p.valueId, { weight: p.suggestedWeight });
    if (!updated) {
      return { ok: false, reason: `value not found: ${p.valueId}` };
    }
    this.logger?.info(LAYER, `已编译 value_shift: ${p.valueId} → 权重 ${p.suggestedWeight}`);
    return { ok: true, applied: `value ${p.valueId} weight=${p.suggestedWeight}` };
  }

  private compileMemoryEdge(p: MemoryEdgePayload): CompileOutcome {
    /* linkMemories 在源/目标记忆缺失时抛错；try/catch 已在 compile() 兜底 */
    this.core.linkMemories(p.sourceId, p.targetId, p.relation, p.strength);
    this.logger?.info(LAYER, `已编译 memory_edge: ${p.sourceId} →[${p.relation}] ${p.targetId}`);
    return { ok: true, applied: `edge ${p.sourceId}->${p.targetId} (${p.relation})` };
  }

  private compileNarrativePatch(p: NarrativePatchPayload): CompileOutcome {
    if (typeof p.narrative !== 'string' || p.narrative.trim().length === 0) {
      return { ok: false, reason: 'narrative_patch requires non-empty narrative' };
    }
    this.core.updateNarrative(p.narrative);
    this.logger?.info(LAYER, '已编译 narrative_patch');
    return { ok: true, applied: 'narrative updated' };
  }

  private compileResponseTemplate(personaId: string, artifactId: string, p: ResponseTemplatePayload): CompileOutcome {
    /* 落专用持久表（版本化、不衰减），而非会被衰减/驱逐的 procedural memory。
     * 同 intent 追加新版本，溯源到来源工件。需注入 templates store + clock。 */
    if (!this.templates || !this.clock) {
      return { ok: false, reason: 'response_template store not configured (ResponseTemplateStore + Clock required)' };
    }
    const version = this.templates.appendVersion(personaId, p.intent, p.template, artifactId, this.clock.now());
    this.logger?.info(LAYER, `已编译 response_template: intent=${p.intent} → v${version}（专用表，持久）`);
    return { ok: true, applied: `template intent=${p.intent} v${version}` };
  }

  /** L2 决策风格校准 → CoreRhythmLayer.setDecisionStyle（部分合并更新）。 */
  private compileDecisionStylePatch(p: DecisionStylePatchPayload): CompileOutcome {
    /* 白名单取已定义的合法字段（Codex WP-1 Minor：不把未知 numeric key 纳入 patch/log）。
     * 字段值域已由 kernel validatePayloadShape 按真实领域约束校验过；setDecisionStyle 合并 + 落库 + emit。 */
    const patch: Partial<DecisionStylePatchPayload> = {};
    for (const f of DECISION_STYLE_PATCH_FIELDS) {
      const v = p[f];
      if (typeof v === 'number') (patch as Record<string, number>)[f] = v;
    }
    this.core.setDecisionStyle(patch);
    const applied = Object.keys(patch).join(',');
    this.logger?.info(LAYER, `已编译 decision_style_patch: ${applied}`);
    return { ok: true, applied: `decision_style ${applied}` };
  }

  /** L3 认知模型校准 → CoreRhythmLayer.setCognitiveModel（scalar 直传，map **entry 级合并**而非整张替换）。 */
  private compileCognitiveModelPatch(p: CognitiveModelPatchPayload): CompileOutcome {
    /* setCognitiveModel 对 map 字段是 `patch.beliefs ?? current`（整张替换），故这里先读 current 再逐项
     * merge，保留旧 key、覆盖/新增 patch key（Codex WP-1 Major：避免覆盖整张认知模型）。 */
    const current = this.core.cognitiveModel.get();
    const patch: Record<string, unknown> = {};
    if (typeof p.attributionStyle === 'number') patch.attributionStyle = p.attributionStyle;
    if (typeof p.growthMindset === 'number') patch.growthMindset = p.growthMindset;
    if (p.beliefs) {
      const merged = new Map(current.beliefs);
      for (const [k, v] of Object.entries(p.beliefs)) merged.set(k, v);
      patch.beliefs = merged;
    }
    if (p.biasWeights) {
      const merged = new Map(current.biasWeights);
      for (const [k, v] of Object.entries(p.biasWeights)) merged.set(k, v);
      patch.biasWeights = merged;
    }
    this.core.setCognitiveModel(patch as Parameters<CoreRhythmLayer['setCognitiveModel']>[0]);
    const applied = Object.keys(patch).join(',');
    this.logger?.info(LAYER, `已编译 cognitive_model_patch: ${applied}`);
    return { ok: true, applied: `cognitive_model ${applied}` };
  }
}

/** L2 决策风格可校准字段白名单（与 kernel DecisionStylePatchPayload 一致）。 */
const DECISION_STYLE_PATCH_FIELDS: ReadonlyArray<keyof DecisionStylePatchPayload> = [
  'riskAppetite', 'timeHorizon', 'explorationBias', 'lossAversion', 'deliberationDepth', 'regretSensitivity',
];
