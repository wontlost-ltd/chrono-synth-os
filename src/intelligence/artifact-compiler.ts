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
 *
 * 其余 kind（rule / decision_style_patch / cognitive_model_patch）目前不编译，
 * 返回 unsupported——它们停留在 approved/pending 待后续 PR 接专用编译路径，
 * 绝不静默丢弃（D3：自我修改必须可解释）。
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
}
