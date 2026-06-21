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
 *   - rule → RuleStore 专用持久表（版本化），由 RuleEngine 作为 constraint-penalty 同类机制消费。
 *
 * 快照/回滚由调用方（DistillationService）负责：它持有 ChronoSynthOS，能在编译
 * 批次前后做 snapshot 并在失败时 restore。编译器本身只报告每件工件的成败。
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { Logger } from '../utils/logger.js';
import type { ResponseTemplateStore } from '../storage/response-template-store.js';
import type { RuleStore } from '../storage/rule-store.js';
import type { Clock } from '../utils/clock.js';
import type {
  DistilledArtifact,
  ValueShiftPayload,
  MemoryEdgePayload,
  ResponseTemplatePayload,
  RulePayload,
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

/** 按 personaId 解析目标认知内核（ADR-0056 K5：编译落到该 persona 自己的 core）。 */
export type CoreResolver = (personaId: string) => CoreRhythmLayer;

export class ArtifactCompiler {
  private readonly resolveCore: CoreResolver;

  constructor(
    /**
     * 目标内核：可传**单个 core**（向后兼容：所有 persona 都编译到它，旧行为）或
     * **resolver (personaId)=>core**（ADR-0056 K5：编译落到该 persona 自己的内核）。
     */
    core: CoreRhythmLayer | CoreResolver,
    private readonly logger?: Logger,
    /** response_template 专用持久表（ADR-0047）；未注入时该 kind 不可编译，显式失败。 */
    private readonly templates?: ResponseTemplateStore,
    private readonly clock?: Clock,
    /** rule 专用持久表（ADR-0047）；未注入时该 kind 不可编译，显式失败。 */
    private readonly rules?: RuleStore,
  ) {
    this.resolveCore = typeof core === 'function' ? core : () => core;
  }

  /**
   * 编译单件工件到核心状态（ADR-0056 K5）。调用方应仅对已通过校验且处于可编译状态的工件调用。
   * personaId 经 resolver 寻址到该 persona 的内核。返回成败；失败不抛错（让上层按批次决定是否回滚）。
   *
   * ⚠️ persona 隔离的**真实边界**（与 CoreRhythmLayer 一致）：
   *   - narrative_patch / decision_style_patch / cognitive_model_patch → 人格特征三件套，**已按
   *     (tenant, persona) 隔离**（K2 executor 已扩）：不同 persona 各自落各自的行，互不串脑。
   *   - response_template / rule → 专用持久表，已**按 persona 对象级**落库。
   *   - value_shift / memory_edge → ValueStore / CognitiveMemoryGraph 在 CoreRhythmLayer 内**仍是
   *     tenant 键**（persona_id 列已加但 executor 未扩，K5b 后续子片）。故对非 default persona，这两类
   *     编译写入的是**同租户共享**的价值/记忆，尚未 persona 隔离——resolver 正确寻址，但底层 store 未隔离。
   *     未在本片声明 per-persona 隔离；K5 的 per-persona 自成长以三件套为准。
   */
  compile(personaId: string, artifact: DistilledArtifact): CompileOutcome {
    try {
      const core = this.resolveCore(personaId);
      switch (artifact.kind) {
        case 'value_shift':
          return this.compileValueShift(core, artifact.payload as ValueShiftPayload);
        case 'memory_edge':
          return this.compileMemoryEdge(core, artifact.payload as MemoryEdgePayload);
        case 'narrative_patch':
          return this.compileNarrativePatch(core, artifact.payload as NarrativePatchPayload);
        case 'response_template':
          return this.compileResponseTemplate(personaId, artifact.id, artifact.payload as ResponseTemplatePayload);
        case 'decision_style_patch':
          return this.compileDecisionStylePatch(core, artifact.payload as DecisionStylePatchPayload);
        case 'cognitive_model_patch':
          return this.compileCognitiveModelPatch(core, artifact.payload as CognitiveModelPatchPayload);
        case 'rule':
          return this.compileRule(personaId, artifact.id, artifact.payload as RulePayload);
        default:
          return { ok: false, reason: `unsupported artifact kind for compile: ${artifact.kind}` };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger?.warn(LAYER, `编译失败 [${artifact.kind}] ${artifact.id}: ${reason}`);
      return { ok: false, reason };
    }
  }

  private compileValueShift(core: CoreRhythmLayer, p: ValueShiftPayload): CompileOutcome {
    const updated = core.updateValueParams(p.valueId, { weight: p.suggestedWeight });
    if (!updated) {
      return { ok: false, reason: `value not found: ${p.valueId}` };
    }
    this.logger?.info(LAYER, `已编译 value_shift: ${p.valueId} → 权重 ${p.suggestedWeight}`);
    return { ok: true, applied: `value ${p.valueId} weight=${p.suggestedWeight}` };
  }

  private compileMemoryEdge(core: CoreRhythmLayer, p: MemoryEdgePayload): CompileOutcome {
    /* linkMemories 在源/目标记忆缺失时抛错；try/catch 已在 compile() 兜底 */
    core.linkMemories(p.sourceId, p.targetId, p.relation, p.strength);
    this.logger?.info(LAYER, `已编译 memory_edge: ${p.sourceId} →[${p.relation}] ${p.targetId}`);
    return { ok: true, applied: `edge ${p.sourceId}->${p.targetId} (${p.relation})` };
  }

  private compileNarrativePatch(core: CoreRhythmLayer, p: NarrativePatchPayload): CompileOutcome {
    if (typeof p.narrative !== 'string' || p.narrative.trim().length === 0) {
      return { ok: false, reason: 'narrative_patch requires non-empty narrative' };
    }
    core.updateNarrative(p.narrative);
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

  private compileRule(personaId: string, artifactId: string, p: RulePayload): CompileOutcome {
    /* 落专用规则表（版本化），RuleEngine 决策时消费每个 ruleId 的最新版本。
     * 需注入 rules store + clock，与 response_template 的持久化纪律一致。 */
    if (!this.rules || !this.clock) {
      return { ok: false, reason: 'rule store not configured (RuleStore + Clock required)' };
    }
    const version = this.rules.appendVersion(personaId, p, artifactId, this.clock.now());
    this.logger?.info(LAYER, `已编译 rule: ruleId=${p.ruleId} → v${version}（专用表，持久）`);
    return { ok: true, applied: `rule ${p.ruleId} v${version}` };
  }

  /** L2 决策风格校准 → CoreRhythmLayer.setDecisionStyle（部分合并更新）。 */
  private compileDecisionStylePatch(core: CoreRhythmLayer, p: DecisionStylePatchPayload): CompileOutcome {
    /* 白名单取已定义的合法字段（Codex WP-1 Minor：不把未知 numeric key 纳入 patch/log）。
     * 字段值域已由 kernel validatePayloadShape 按真实领域约束校验过；setDecisionStyle 合并 + 落库 + emit。 */
    const patch: Partial<DecisionStylePatchPayload> = {};
    for (const f of DECISION_STYLE_PATCH_FIELDS) {
      const v = p[f];
      if (typeof v === 'number') (patch as Record<string, number>)[f] = v;
    }
    core.setDecisionStyle(patch);
    const applied = Object.keys(patch).join(',');
    this.logger?.info(LAYER, `已编译 decision_style_patch: ${applied}`);
    return { ok: true, applied: `decision_style ${applied}` };
  }

  /** L3 认知模型校准 → CoreRhythmLayer.setCognitiveModel（scalar 直传，map **entry 级合并**而非整张替换）。 */
  private compileCognitiveModelPatch(core: CoreRhythmLayer, p: CognitiveModelPatchPayload): CompileOutcome {
    /* setCognitiveModel 对 map 字段是 `patch.beliefs ?? current`（整张替换），故这里先读 current 再逐项
     * merge，保留旧 key、覆盖/新增 patch key（Codex WP-1 Major：避免覆盖整张认知模型）。 */
    const current = core.cognitiveModel.get();
    const patch: Record<string, unknown> = {};
    if (typeof p.attributionStyle === 'number') patch.attributionStyle = p.attributionStyle;
    if (typeof p.growthMindset === 'number') patch.growthMindset = p.growthMindset;
    /* ④ L3 扩展标量：模糊容忍 / 直觉↔分析，编译进认知模型（成长管线可学习落地）。 */
    if (typeof p.ambiguityTolerance === 'number') patch.ambiguityTolerance = p.ambiguityTolerance;
    if (typeof p.analyticalIntuitive === 'number') patch.analyticalIntuitive = p.analyticalIntuitive;
    if (p.beliefs) {
      const merged = new Map<string, number>(current.beliefs);
      for (const [k, v] of Object.entries(p.beliefs)) merged.set(k, Number(v));
      patch.beliefs = merged;
    }
    if (p.biasWeights) {
      const merged = new Map<string, number>(current.biasWeights);
      for (const [k, v] of Object.entries(p.biasWeights)) merged.set(k, Number(v));
      patch.biasWeights = merged;
    }
    core.setCognitiveModel(patch as Parameters<CoreRhythmLayer['setCognitiveModel']>[0]);
    const applied = Object.keys(patch).join(',');
    this.logger?.info(LAYER, `已编译 cognitive_model_patch: ${applied}`);
    return { ok: true, applied: `cognitive_model ${applied}` };
  }
}

/** L2 决策风格可校准字段白名单（与 kernel DecisionStylePatchPayload 一致）。 */
const DECISION_STYLE_PATCH_FIELDS: ReadonlyArray<keyof DecisionStylePatchPayload> = [
  'riskAppetite', 'timeHorizon', 'explorationBias', 'lossAversion', 'deliberationDepth', 'regretSensitivity',
];
