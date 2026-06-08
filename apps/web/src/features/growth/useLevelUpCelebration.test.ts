import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { _resetCelebrationForTest, useLevelUpCelebration } from './useLevelUpCelebration';

/* useLevelUpCelebration depends on useUserLevel which uses Date.now()
 * to derive days-of-use. We mock useUserLevel directly so each test
 * controls the level under inspection. */
const levelMock = vi.hoisted(() => vi.fn());
vi.mock('./useUserLevel', () => ({
  useUserLevel: () => levelMock(),
}));

describe('useLevelUpCelebration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetCelebrationForTest();
    levelMock.mockReset();
  });

  it('does not fire on first observation (welcome covers L1)', () => {
    levelMock.mockReturnValue({ level: 'L1', daysOfUse: 0, daysUntilNext: 3, hasUnlocked: () => false });
    const { result } = renderHook(() => useLevelUpCelebration());
    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem('chrono.user.last-celebrated-level')).toBe('L1');
  });

  it('fires when user crosses L1 → L2', () => {
    window.localStorage.setItem('chrono.user.last-celebrated-level', 'L1');
    levelMock.mockReturnValue({ level: 'L2', daysOfUse: 4, daysUntilNext: 3, hasUnlocked: () => false });

    const { result } = renderHook(() => useLevelUpCelebration());
    expect(result.current.pending).toEqual({ from: 'L1', to: 'L2' });
  });

  it('does not fire when level holds steady', () => {
    window.localStorage.setItem('chrono.user.last-celebrated-level', 'L2');
    levelMock.mockReturnValue({ level: 'L2', daysOfUse: 5, daysUntilNext: 2, hasUnlocked: () => false });

    const { result } = renderHook(() => useLevelUpCelebration());
    expect(result.current.pending).toBeNull();
  });

  it('acknowledge persists the new level and clears pending', () => {
    window.localStorage.setItem('chrono.user.last-celebrated-level', 'L1');
    levelMock.mockReturnValue({ level: 'L3', daysOfUse: 8, daysUntilNext: 22, hasUnlocked: () => false });

    const { result } = renderHook(() => useLevelUpCelebration());
    expect(result.current.pending?.to).toBe('L3');

    act(() => {
      result.current.acknowledge();
    });

    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem('chrono.user.last-celebrated-level')).toBe('L3');
  });

  it('ignores corrupt storage and treats as fresh install', () => {
    window.localStorage.setItem('chrono.user.last-celebrated-level', 'NOT_A_LEVEL');
    levelMock.mockReturnValue({ level: 'L2', daysOfUse: 4, daysUntilNext: 3, hasUnlocked: () => false });

    const { result } = renderHook(() => useLevelUpCelebration());
    /* No celebration on first observation; storage gets seeded with current level. */
    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem('chrono.user.last-celebrated-level')).toBe('L2');
  });
});
