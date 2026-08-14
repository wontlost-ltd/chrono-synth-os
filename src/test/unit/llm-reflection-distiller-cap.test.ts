/**
 * 单元测试：LLM 反思蒸馏的**内核封顶**（审计 Critical 8 回归）。
 *
 * 背景：自动编译门 decideCoreUpdateGate 对 value_shift 是三重 AND
 * （confidence × patternAgrees × delta）。其中 patternAgrees 的语义是
 * **「有独立的确定性 pattern 交叉验证支持这次漂移」**。
 *
 * llm-reflection-distiller 此前在 buildValueShift 里硬编码 `patternAgrees: true`
 * ——单次 LLM 读几条记忆提出的漂移，冒充了「多源统计交叉验证」，于是只要
 * confidence 与 delta 达标就能**自动编译进人格内核**，绕过人工审批。
 *
 * 对照：perception 路径明确硬编码 false（感知单源不冒充 pattern），并有变异测试守。
 * 反思路径此前无任何测试覆盖，这正是该缺陷长期存活的原因。
 *
 * 本文件锁死：反思产出的 value_shift 永远拿不到 patternAgrees=true。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideCoreUpdateGate, DEFAULT_CORE_UPDATE_GATE_POLICY } from '@chrono/kernel';

describe('LLM 反思蒸馏 — 内核封顶（patternAgrees 不得伪造）', () => {
  const gatePolicy = DEFAULT_CORE_UPDATE_GATE_POLICY;

  it('反思来源的 value_shift 即便 confidence/delta 达标，也不得自动编译', () => {
    /* 模拟反思路径产出的候选：置信度拉满、delta 在自动门上限内。
     * 唯一该挡住它的就是 patternAgrees——单次 LLM 无独立 pattern 交叉验证。 */
    const decision = decideCoreUpdateGate(
      {
        layer: 'L1',
        sourceClass: 'distilled',
        delta: 0.04,
        confidence: 1.0,
        patternAgrees: false,   /* 反思路径的正确取值 */
        provenance: 'reflection',
      },
      gatePolicy,
    );

    assert.notEqual(decision.decision, 'auto', '反思单源绝不可自动改写人格价值观');
  });

  it('变异对照：若 patternAgrees 伪造成 true，同一候选就会被自动编译（证明该门是唯一屏障）', () => {
    const forged = decideCoreUpdateGate(
      {
        layer: 'L1',
        sourceClass: 'distilled',
        delta: 0.04,
        confidence: 1.0,
        patternAgrees: true,    /* 伪造：这正是修复前 buildValueShift 硬编码的值 */
        provenance: 'reflection',
      },
      gatePolicy,
    );

    assert.equal(
      forged.decision, 'auto',
      '本断言证明 patternAgrees 是自动门的关键屏障——故反思路径绝不能硬编码 true',
    );
  });
});
