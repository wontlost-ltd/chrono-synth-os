import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';

const APP_NAME = 'ChronoSynth';

afterEach(() => {
  document.title = '';
});

describe('useDocumentTitle', () => {
  it('sets title as "<title> — ChronoSynth"', () => {
    renderHook(() => useDocumentTitle('Dashboard'));
    expect(document.title).toBe(`Dashboard — ${APP_NAME}`);
  });

  it('falls back to app name when title is empty string', () => {
    renderHook(() => useDocumentTitle(''));
    expect(document.title).toBe(APP_NAME);
  });

  it('restores previous title on unmount', () => {
    document.title = 'Previous Title';
    const { unmount } = renderHook(() => useDocumentTitle('New Page'));
    expect(document.title).toBe(`New Page — ${APP_NAME}`);
    unmount();
    expect(document.title).toBe('Previous Title');
  });

  it('updates title when prop changes', () => {
    const { rerender } = renderHook(({ title }: { title: string }) => useDocumentTitle(title), {
      initialProps: { title: 'Page A' },
    });
    expect(document.title).toBe(`Page A — ${APP_NAME}`);

    rerender({ title: 'Page B' });
    expect(document.title).toBe(`Page B — ${APP_NAME}`);
  });
});
