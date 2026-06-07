import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { _resetHotkeysForTest, formatCombo, registerHotkey, useHotkey } from './hotkeys';
import { renderHook } from '@testing-library/react';

function dispatch(combo: { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean; target?: HTMLElement }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: combo.key,
    metaKey: combo.meta ?? false,
    ctrlKey: combo.ctrl ?? false,
    altKey: combo.alt ?? false,
    shiftKey: combo.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (combo.target) {
    combo.target.dispatchEvent(e);
  } else {
    document.dispatchEvent(e);
  }
  return e;
}

describe('hotkey registry', () => {
  beforeEach(() => {
    _resetHotkeysForTest();
  });

  afterEach(() => {
    _resetHotkeysForTest();
  });

  it('fires handler for a simple modifier combo (cmd+k)', () => {
    const handler = vi.fn();
    registerHotkey('cmd+k', handler);
    dispatch({ key: 'k', meta: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire when the modifier is missing', () => {
    const handler = vi.fn();
    registerHotkey('cmd+k', handler);
    dispatch({ key: 'k' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires sequence handler "g p" only after both keys', () => {
    const handler = vi.fn();
    registerHotkey('g p', handler);

    dispatch({ key: 'g' });
    expect(handler).not.toHaveBeenCalled();

    dispatch({ key: 'p' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire sequence when interrupted by a different key', () => {
    const handler = vi.fn();
    registerHotkey('g p', handler);

    dispatch({ key: 'g' });
    dispatch({ key: 'x' }); // not a prefix → buffer cleared
    dispatch({ key: 'p' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('escape combo fires from inside an input element', () => {
    const handler = vi.fn();
    registerHotkey('escape', handler);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatch({ key: 'Escape', target: input });

    expect(handler).toHaveBeenCalledOnce();
    document.body.removeChild(input);
  });

  it('plain-letter sequences are suppressed inside inputs', () => {
    const handler = vi.fn();
    registerHotkey('g p', handler);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatch({ key: 'g', target: input });
    dispatch({ key: 'p', target: input });

    expect(handler).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('useHotkey unregisters on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useHotkey('cmd+l', handler));
    dispatch({ key: 'l', meta: true });
    expect(handler).toHaveBeenCalledTimes(1);

    unmount();
    dispatch({ key: 'l', meta: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('formatCombo renders ⌘ on mac platforms', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    expect(formatCombo('cmd+k')).toBe('⌘K');
  });

  it('formatCombo renders Ctrl+K on non-mac platforms', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    expect(formatCombo('cmd+k')).toBe('Ctrl+K');
  });
});
