import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  _resetFeatureFlagsForTest,
  getFlagSource,
  getFlagValue,
  refreshFlagsFromStorage,
  setFlagValue,
  useFeatureFlag,
} from './featureFlags';

describe('feature flags', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetFeatureFlagsForTest();
  });

  afterEach(() => {
    window.localStorage.clear();
    _resetFeatureFlagsForTest();
  });

  it('returns the default value when nothing overrides it', () => {
    expect(getFlagValue('cmdk.enabled', false)).toBe(true);
    expect(getFlagSource('cmdk.enabled')).toBe('static');
  });

  it('honours localStorage override over the default', () => {
    window.localStorage.setItem('chrono.flag.cmdk.enabled', 'false');
    refreshFlagsFromStorage();
    expect(getFlagValue('cmdk.enabled', true)).toBe(false);
    expect(getFlagSource('cmdk.enabled')).toBe('override');
  });

  it('localStorage override wins over remote setFlagValue', () => {
    window.localStorage.setItem('chrono.flag.cmdk.enabled', 'true');
    refreshFlagsFromStorage();
    setFlagValue('cmdk.enabled', false);
    expect(getFlagValue('cmdk.enabled', true)).toBe(true);
    expect(getFlagSource('cmdk.enabled')).toBe('override');
  });

  it('remote setFlagValue updates the snapshot when no override exists', () => {
    setFlagValue('experimental.values_health_dashboard', true);
    expect(getFlagValue('experimental.values_health_dashboard', false)).toBe(true);
    expect(getFlagSource('experimental.values_health_dashboard')).toBe('remote');
  });

  it('coerces string-form numbers and booleans from localStorage', () => {
    window.localStorage.setItem('chrono.flag.cmdk.enabled', 'true');
    window.localStorage.setItem('chrono.flag.experimental.values_health_dashboard', 'false');
    refreshFlagsFromStorage();
    expect(getFlagValue('cmdk.enabled', false)).toBe(true);
    expect(getFlagValue('experimental.values_health_dashboard', true)).toBe(false);
  });

  it('useFeatureFlag re-renders when remote value changes', () => {
    const { result } = renderHook(() => useFeatureFlag('experimental.values_health_dashboard', false));
    expect(result.current).toBe(false);
    act(() => {
      setFlagValue('experimental.values_health_dashboard', true);
    });
    expect(result.current).toBe(true);
  });

  it('useFeatureFlag returns the fallback when called for a flag not in the snapshot', () => {
    /* Type system protects against this in callers, but the runtime fallback
     * still needs to behave: cast to bypass for the regression check. */
    const { result } = renderHook(() =>
      useFeatureFlag('nonexistent.flag' as unknown as Parameters<typeof useFeatureFlag>[0], 'safe-default' as unknown as boolean),
    );
    expect(result.current).toBe('safe-default');
  });
});
