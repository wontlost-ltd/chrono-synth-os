import { describe, it, expect } from 'vitest';
import { computeLevel, daysUntilNextLevel, isUnlocked, LEVELS } from './levels';

describe('capability levels (P3.7)', () => {
  it('starts at L1 on day 0', () => {
    expect(computeLevel(0)).toBe('L1');
  });

  it('reaches L2 at exactly 3 days', () => {
    expect(computeLevel(2)).toBe('L1');
    expect(computeLevel(3)).toBe('L2');
  });

  it('reaches L3 at 7 days', () => {
    expect(computeLevel(6)).toBe('L2');
    expect(computeLevel(7)).toBe('L3');
  });

  it('reaches L4 at 30 days and stays there', () => {
    expect(computeLevel(29)).toBe('L3');
    expect(computeLevel(30)).toBe('L4');
    expect(computeLevel(365)).toBe('L4');
  });

  it('isUnlocked is cumulative across levels', () => {
    expect(isUnlocked('L4', 'personas')).toBe(true);  // unlocked at L1
    expect(isUnlocked('L1', 'agent_tools')).toBe(false);
    expect(isUnlocked('L3', 'agent_tools')).toBe(true);
    expect(isUnlocked('L4', 'governance')).toBe(true);
  });

  it('isUnlocked rejects unknown features', () => {
    expect(isUnlocked('L4', 'nonexistent')).toBe(false);
  });

  it('daysUntilNextLevel returns null at max level', () => {
    expect(daysUntilNextLevel(30)).toBeNull();
    expect(daysUntilNextLevel(100)).toBeNull();
  });

  it('daysUntilNextLevel counts down to next boundary', () => {
    expect(daysUntilNextLevel(0)).toBe(3);
    expect(daysUntilNextLevel(2)).toBe(1);
    expect(daysUntilNextLevel(5)).toBe(2);
    expect(daysUntilNextLevel(8)).toBe(22);
  });

  it('LEVELS array is ordered by minDaysOfUse', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i]!.minDaysOfUse).toBeGreaterThan(LEVELS[i - 1]!.minDaysOfUse);
    }
  });
});
