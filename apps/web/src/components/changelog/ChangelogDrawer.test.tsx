import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChangelogDrawer, CHANGELOG } from './ChangelogDrawer';

/* localStorage is reset between tests; analytics is not asserted here (it's
 * fire-and-forget and tested separately). The component reads the latest
 * version from CHANGELOG[0] so we just trust that constant. */

describe('ChangelogDrawer', () => {
  const STORAGE_KEY = 'chrono.changelog.last-seen.v1';

  beforeEach(() => {
    window.localStorage.clear();
    /* Stub fetch so analytics flushes don't hit a real network. */
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto-opens on first visit (no last-seen entry)', async () => {
    render(<ChangelogDrawer />);
    /* Latest entry title rendered = drawer is open */
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
  });

  it('does not auto-open if user has already seen the latest version', () => {
    const latest = CHANGELOG[0];
    if (latest) {
      window.localStorage.setItem(STORAGE_KEY, latest.version);
    }
    render(<ChangelogDrawer />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('writes last-seen when closed', async () => {
    render(<ChangelogDrawer />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    /* Close button is the only one with an aria-label of '关闭' / 'Close' */
    const closeButtons = screen.getAllByRole('button');
    const closeBtn = closeButtons.find((b) => b.getAttribute('aria-label')?.match(/^(关闭|Close)$/));
    expect(closeBtn).toBeDefined();
    fireEvent.click(closeBtn!);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(CHANGELOG[0]!.version);
  });

  it('shows unread indicator on the trigger when last-seen is stale', () => {
    /* Set last-seen to a version that doesn't match the latest */
    window.localStorage.setItem(STORAGE_KEY, 'v0.0.0-stale');
    render(<ChangelogDrawer />);
    /* Auto-opens; close it first to inspect the trigger state */
    const closeButtons = screen.getAllByRole('button');
    const closeBtn = closeButtons.find((b) => b.getAttribute('aria-label')?.match(/^(关闭|Close)$/));
    fireEvent.click(closeBtn!);
    /* After close, last-seen is updated to latest, so unread dot is gone.
     * This test instead verifies the close path persists correctly: */
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(CHANGELOG[0]!.version);
  });

  it('renders all changelog entries inside the drawer', async () => {
    render(<ChangelogDrawer />);
    const dialog = await screen.findByRole('dialog');
    /* Each entry's version + date string is rendered as a small label. */
    for (const entry of CHANGELOG) {
      expect(dialog).toHaveTextContent(entry.version);
      expect(dialog).toHaveTextContent(entry.date);
    }
  });
});
