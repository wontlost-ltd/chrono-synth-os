import { describe, it, expect } from 'vitest';
import { _runRulesForTest } from './useContextualSuggestions';

describe('contextual suggestions rules', () => {
  it('emits "create first persona" when no personas exist', () => {
    const out = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L1',
      hasPersonas: false,
      hasKnowledge: false,
    });
    expect(out.find((s) => s.id === 'create_first_persona')).toBeDefined();
  });

  it('does not emit "first persona" once personas exist', () => {
    const out = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L1',
      hasPersonas: true,
      hasKnowledge: false,
    });
    expect(out.find((s) => s.id === 'create_first_persona')).toBeUndefined();
  });

  it('emits "add knowledge" only after personas exist', () => {
    const without = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L1',
      hasPersonas: false,
      hasKnowledge: false,
    });
    expect(without.find((s) => s.id === 'add_first_knowledge')).toBeUndefined();

    const with_ = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L1',
      hasPersonas: true,
      hasKnowledge: false,
    });
    expect(with_.find((s) => s.id === 'add_first_knowledge')).toBeDefined();
  });

  it('drift suggestion only at L2+ on the dashboard', () => {
    const l1 = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L1',
      hasPersonas: true,
      hasKnowledge: true,
    });
    expect(l1.find((s) => s.id === 'view_drift')).toBeUndefined();

    const l3 = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L3',
      hasPersonas: true,
      hasKnowledge: true,
    });
    expect(l3.find((s) => s.id === 'view_drift')).toBeDefined();
  });

  it('agent-tool suggestion only at L3+', () => {
    const l2 = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L2',
      hasPersonas: true,
      hasKnowledge: true,
    });
    expect(l2.find((s) => s.id === 'grant_first_tool')).toBeUndefined();

    const l3 = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L3',
      hasPersonas: true,
      hasKnowledge: true,
    });
    expect(l3.find((s) => s.id === 'grant_first_tool')).toBeDefined();
  });

  it('all suggestions have a score in [0, 1]', () => {
    const out = _runRulesForTest({
      pathname: '/dashboard',
      level: 'L4',
      hasPersonas: false,
      hasKnowledge: false,
    });
    for (const s of out) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });
});
