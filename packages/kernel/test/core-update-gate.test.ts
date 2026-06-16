/**
 * ADR-0047 统一门控判定 decideCoreUpdateGate + 反漂移保证。
 * 验证：deterministic 分支（L0/L1 幅度门）+ distilled 分支（value_shift/memory_edge 证据门）
 * 的决策；并断言 UpdateGate.requiresConfirmation 与 canAutoCompile 现在与共享层一致（同源）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCoreUpdateGate,
  trustTierOf,
  DEFAULT_CORE_UPDATE_GATE_POLICY,
} from '../src/domain/core-self/core-update-gate.js';
import { requiresConfirmation, DEFAULT_UPDATE_GATE_CONFIG } from '../src/domain/persona/update-gate-logic.js';
import { canAutoCompile, DEFAULT_DISTILLATION_POLICY } from '../src/domain/core-self/distilled-artifact-types.js';
import type { DistilledArtifact } from '../src/domain/core-self/distilled-artifact-types.js';

describe('decideCoreUpdateGate (ADR-0047 统一门控)', () => {
  describe('deterministic 来源（无证据门，只看幅度）', () => {
    it('L0 恒需确认', () => {
      assert.equal(decideCoreUpdateGate({ layer: 'L0', sourceClass: 'deterministic' }).decision, 'confirm');
    });
    it('L1 |delta|<=0.15 自动，>0.15 需确认（边界 0.15 自动）', () => {
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.15 }).decision, 'auto');
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.16 }).decision, 'confirm');
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: -0.2 }).decision, 'confirm');
    });
    it('deterministic 来源不看 confidence（与 distilled 的本质区别）', () => {
      /* 低 confidence 但确定性来源 + 小 delta → 仍自动（确定性来源可信） */
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.1, confidence: 0.1 }).decision, 'auto');
    });
  });

  describe('distilled 来源（叠加证据门）', () => {
    it('value_shift：conf>=0.8 ∧ patternAgrees ∧ |delta|<=0.05 才自动', () => {
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.05, confidence: 0.8, patternAgrees: true }).decision, 'auto');
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.05, confidence: 0.79, patternAgrees: true }).decision, 'confirm');
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.05, confidence: 0.9, patternAgrees: false }).decision, 'confirm');
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.06, confidence: 0.9, patternAgrees: true }).decision, 'confirm');
    });
    it('memory_edge：conf>=0.75 ∧ evidence>=2 才自动', () => {
      assert.equal(decideCoreUpdateGate({ layer: 'MemoryGraph', sourceClass: 'distilled', confidence: 0.75, evidenceCount: 2 }).decision, 'auto');
      assert.equal(decideCoreUpdateGate({ layer: 'MemoryGraph', sourceClass: 'distilled', confidence: 0.75, evidenceCount: 1 }).decision, 'confirm');
    });
    it('L2/L3/Narrative/Rule/Template 蒸馏来源默认需审批', () => {
      for (const layer of ['L2', 'L3', 'Narrative', 'Rule', 'Template'] as const) {
        assert.equal(decideCoreUpdateGate({ layer, sourceClass: 'distilled', confidence: 0.99 }).decision, 'confirm');
      }
    });
  });

  describe('① 来源信任分级（provenance → trust tier → confidence 门槛乘数）', () => {
    it('trustTierOf 映射：reflection/onboarding=internal，conversation/knowledge_import=semi，perception=external', () => {
      assert.equal(trustTierOf('reflection'), 'internal');
      assert.equal(trustTierOf('onboarding'), 'internal');
      assert.equal(trustTierOf('conversation'), 'semi');
      assert.equal(trustTierOf('knowledge_import'), 'semi');
      assert.equal(trustTierOf('perception'), 'external');
    });

    it('向后兼容：不给 provenance = tier internal（乘数 1.0），与旧二元行为逐字等价', () => {
      /* conf 0.8 在默认阈值 0.8 边界：不给 provenance 应仍 auto（internal 乘数 1.0，门槛 0.8）。 */
      const r = decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.05, confidence: 0.8, patternAgrees: true });
      assert.equal(r.decision, 'auto');
    });

    it('external(perception) 门槛被抬高：同 conf 0.8 在 reflection 自动、在 perception 需确认', () => {
      const base = { layer: 'L1' as const, sourceClass: 'distilled' as const, delta: 0.05, confidence: 0.8, patternAgrees: true };
      /* reflection(internal 1.0)：门槛 0.8，conf 0.8 → auto。 */
      assert.equal(decideCoreUpdateGate({ ...base, provenance: 'reflection' }).decision, 'auto');
      /* perception(external 1.25)：门槛 0.8×1.25=1.0，conf 0.8 < 1.0 → confirm（外部输入更谨慎）。 */
      assert.equal(decideCoreUpdateGate({ ...base, provenance: 'perception' }).decision, 'confirm');
    });

    it('perception 高置信仍可自动（门槛抬高但非禁止）：conf 1.0 过 external 门', () => {
      /* memory_edge external 门槛 0.75×1.25=0.9375；conf 1.0 ≥ 0.9375 → auto。 */
      const r = decideCoreUpdateGate({
        layer: 'MemoryGraph', sourceClass: 'distilled', confidence: 1.0, evidenceCount: 2, provenance: 'perception',
      });
      assert.equal(r.decision, 'auto');
      assert.match(r.reason, /external/);
    });

    it('semi(conversation) 介于两者之间：门槛 0.8×1.1=0.88，conf 0.85 需确认、0.9 自动', () => {
      const base = { layer: 'L1' as const, sourceClass: 'distilled' as const, delta: 0.05, patternAgrees: true, provenance: 'conversation' as const };
      assert.equal(decideCoreUpdateGate({ ...base, confidence: 0.85 }).decision, 'confirm');
      assert.equal(decideCoreUpdateGate({ ...base, confidence: 0.9 }).decision, 'auto');
    });

    it('信任分级只影响 distilled：deterministic 来源给了 provenance 也不受乘数影响', () => {
      /* deterministic L1 不看 confidence/provenance，只看 delta。 */
      const r = decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.1, confidence: 0.1, provenance: 'perception' });
      assert.equal(r.decision, 'auto');
    });
  });

  describe('② 不确定性预算（窗口内未验证成长累计达上限 → 降级 confirm）', () => {
    const budgeted = { ...DEFAULT_CORE_UPDATE_GATE_POLICY, unverifiedGrowthBudgetPerWindow: 3 };
    /* 一条本会 auto 的 distilled value_shift。 */
    const passingInput = { layer: 'L1' as const, sourceClass: 'distilled' as const, delta: 0.05, confidence: 0.85, patternAgrees: true };

    it('向后兼容：不传 unverifiedGrowthInWindow = 不计预算（默认预算极大也不限）', () => {
      assert.equal(decideCoreUpdateGate(passingInput).decision, 'auto');
      assert.equal(decideCoreUpdateGate({ ...passingInput, unverifiedGrowthInWindow: 999 }).decision, 'auto', '默认 policy 预算 MAX_SAFE_INTEGER');
    });

    it('窗口未用尽（< 预算）→ 仍 auto', () => {
      assert.equal(decideCoreUpdateGate({ ...passingInput, unverifiedGrowthInWindow: 2 }, budgeted).decision, 'auto');
    });

    it('窗口达预算上限（>= 预算）→ 本条即使过门也降级 confirm', () => {
      const r = decideCoreUpdateGate({ ...passingInput, unverifiedGrowthInWindow: 3 }, budgeted);
      assert.equal(r.decision, 'confirm');
      assert.match(r.reason, /budget reached/);
    });

    it('预算只降级 auto，不影响本就 confirm 的（confirm 已需人工，不必再降级）', () => {
      /* 一条本就 confirm 的（conf 0.5 不过门）+ 窗口超预算 → 仍 confirm，但 reason 是门控失败而非预算。 */
      const r = decideCoreUpdateGate(
        { layer: 'L1', sourceClass: 'distilled', delta: 0.05, confidence: 0.5, patternAgrees: true, unverifiedGrowthInWindow: 99 },
        budgeted,
      );
      assert.equal(r.decision, 'confirm');
      assert.match(r.reason, /fails one of/, '是门控失败原因，不是预算降级');
    });

    it('预算与信任分级叠加：external 门槛抬高 + 窗口超预算，两道都生效', () => {
      /* perception conf 0.95 过 external 门（0.9375）但窗口超预算 → 仍降级 confirm。 */
      const r = decideCoreUpdateGate(
        { layer: 'MemoryGraph', sourceClass: 'distilled', confidence: 0.95, evidenceCount: 2, provenance: 'perception', unverifiedGrowthInWindow: 3 },
        budgeted,
      );
      assert.equal(r.decision, 'confirm');
      assert.match(r.reason, /budget reached/);
    });
  });

  describe('provenance 差异是正当的（不是漂移）：同 layer 同 delta，来源不同→门控不同', () => {
    it('L1 +0.10：确定性自动，蒸馏需确认（来源可信度不同，正当）', () => {
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.10 }).decision, 'auto');
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.10, confidence: 0.95, patternAgrees: true }).decision, 'confirm');
    });
  });

  describe('反漂移：两套门控入口与共享层同源', () => {
    function valueShiftArtifact(delta: number, confidence: number, patternAgrees: boolean): DistilledArtifact {
      return {
        id: 'd1', kind: 'value_shift', source: 'reflection', confidence,
        evidence: [{ type: 'pattern', id: 'e1', score: 0.9 }],
        status: 'candidate', createdAt: 1000,
        payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.5 + delta, delta, patternAgrees },
      } as DistilledArtifact;
    }

    it('canAutoCompile 与共享层 distilled 判定一致', () => {
      /* 自动：conf 0.85 pattern true delta 0.04 */
      assert.equal(canAutoCompile(valueShiftArtifact(0.04, 0.85, true)), true);
      assert.equal(
        decideCoreUpdateGate({ layer: 'L1', sourceClass: 'distilled', delta: 0.04, confidence: 0.85, patternAgrees: true }).decision,
        'auto',
      );
      /* 需审批：delta 0.10 超 0.05 */
      assert.equal(canAutoCompile(valueShiftArtifact(0.10, 0.95, true)), false);
    });

    it('requiresConfirmation 与共享层 deterministic 判定一致', () => {
      /* L1 0.10 → 不需确认（auto）；0.20 → 需确认 */
      assert.equal(requiresConfirmation(DEFAULT_UPDATE_GATE_CONFIG, 'L1', 0.10), false);
      assert.equal(requiresConfirmation(DEFAULT_UPDATE_GATE_CONFIG, 'L1', 0.20), true);
      assert.equal(requiresConfirmation(DEFAULT_UPDATE_GATE_CONFIG, 'L0', 0), true);
      /* 与共享层同结论 */
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.10 }).decision === 'confirm', false);
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.20 }).decision === 'confirm', true);
    });

    it('阈值单一来源：改共享 policy 的 L1 幅度阈值，判定随之变（杜绝分叉）', () => {
      const strict = { ...DEFAULT_CORE_UPDATE_GATE_POLICY, deterministicL1MaxAutoDelta: 0.05 };
      assert.equal(decideCoreUpdateGate({ layer: 'L1', sourceClass: 'deterministic', delta: 0.10 }, strict).decision, 'confirm');
    });

    it('旧默认常量从统一 policy 派生（真正单一来源，非两份硬编码）', () => {
      /* distillation 默认阈值 === 统一 policy distilled 字段 */
      assert.equal(DEFAULT_DISTILLATION_POLICY.valueShiftMinConfidence, DEFAULT_CORE_UPDATE_GATE_POLICY.distilledValueShiftMinConfidence);
      assert.equal(DEFAULT_DISTILLATION_POLICY.valueShiftMaxDelta, DEFAULT_CORE_UPDATE_GATE_POLICY.distilledValueShiftMaxDelta);
      assert.equal(DEFAULT_DISTILLATION_POLICY.memoryEdgeMinConfidence, DEFAULT_CORE_UPDATE_GATE_POLICY.distilledMemoryEdgeMinConfidence);
      assert.equal(DEFAULT_DISTILLATION_POLICY.memoryEdgeMinEvidence, DEFAULT_CORE_UPDATE_GATE_POLICY.distilledMemoryEdgeMinEvidence);
      /* UpdateGate 默认 L0/L1 === 统一 policy deterministic 字段 */
      assert.equal(DEFAULT_UPDATE_GATE_CONFIG.l0RequiresConfirmation, DEFAULT_CORE_UPDATE_GATE_POLICY.deterministicL0RequiresConfirmation);
      assert.equal(DEFAULT_UPDATE_GATE_CONFIG.l1ConfirmationThreshold, DEFAULT_CORE_UPDATE_GATE_POLICY.deterministicL1MaxAutoDelta);
    });
  });
});
