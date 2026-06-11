/**
 * ADR-0047：rule 蒸馏工件端到端编译路径。
 * ingest(rule) 默认不自动编译 → 人工 approve → RuleStore active rules → RuleEngine 排序生效。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { compilePersonaState } from '../../intelligence/persona-state.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { PersonaOSState } from '../../types/personality-os.js';
import type { RulePayload } from '@chrono/kernel';

describe('DistillationService rule compilation path (ADR-0047)', () => {
  it('rule artifact 需人工 approve，编译后 active rule 影响 RuleEngine 排序', () => {
    const clock = new TestClock(1000);
    const os = new ChronoSynthOS({ clock, logger: new SilentLogger() });
    const personaId = 'persona_rule_e2e';

    const ingested = os.distillation.ingest(personaId, {
      kind: 'rule',
      source: 'reflection',
      payload: { ruleId: 'prefer_quality', condition: '质量', action: 'prefer', weight: 1 },
      confidence: 0.99,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.9 }],
    });

    assert.equal(ingested.status, 'pending', 'rule 不在 auto-compile 白名单，必须人工 approve');
    const approved = os.distillation.approve(personaId, ingested.artifact.id);
    assert.equal(approved.ok, true, approved.ok ? '' : approved.reason);
    if (approved.ok) assert.equal(approved.artifact.status, 'compiled');

    const activeRules = os.rules.getActiveRules(personaId);
    assert.deepEqual(activeRules, [
      { ruleId: 'prefer_quality', condition: '质量', action: 'prefer', weight: 1 },
    ]);

    const engine = new RuleEngine(clock, undefined, new SilentLogger());
    const baseState = compilePersonaState(os.core);
    const state = { ...baseState, L1: new Map(), rules: activeRules } as PersonaOSState & { rules: RulePayload[] };
    const result = engine.evaluate({
      id: 'case-rule-e2e',
      title: '供应商选择',
      description: '需要在两个方案中选择',
      alternatives: ['拖延处理', '质量优先'],
    }, state);

    assert.equal(result.recommendedAlternative, '质量优先');
  });
});
