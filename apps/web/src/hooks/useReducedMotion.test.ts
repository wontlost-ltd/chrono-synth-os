import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from './useReducedMotion';

interface MockMQ {
  matches: boolean;
  listeners: Set<(e: { matches: boolean }) => void>;
  addEventListener: (type: string, h: (e: { matches: boolean }) => void) => void;
  removeEventListener: (type: string, h: (e: { matches: boolean }) => void) => void;
}

let mockMQ: MockMQ;

function installMatchMedia(initial: boolean): void {
  mockMQ = {
    matches: initial,
    listeners: new Set(),
    addEventListener: (_type, h) => { mockMQ.listeners.add(h); },
    removeEventListener: (_type, h) => { mockMQ.listeners.delete(h); },
  };
  window.matchMedia = vi.fn().mockReturnValue(mockMQ) as unknown as typeof window.matchMedia;
}

describe('useReducedMotion', () => {
  beforeEach(() => {
    installMatchMedia(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when the user has not opted out', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when matchMedia reports a reduce preference', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('updates when the media query flips at runtime', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mockMQ.matches = true;
      mockMQ.listeners.forEach((h) => h({ matches: true }));
    });

    expect(result.current).toBe(true);
  });

  it('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useReducedMotion());
    expect(mockMQ.listeners.size).toBe(1);
    unmount();
    expect(mockMQ.listeners.size).toBe(0);
  });
});
