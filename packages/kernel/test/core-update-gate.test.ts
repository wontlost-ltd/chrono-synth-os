/**
 * ADR-0047 统一门控判定 decideCoreUpdateGate + 反漂移保证。
 * 验证：deterministic 分支（L0/L1 幅度门）+ distilled 分支（value_shift/memory_edge 证据门）
 * 的决策；并断言 UpdateGate.requiresConfirmation 与 canAutoCompile 现在与共享层一致（同源）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCoreUpdateGate,
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
