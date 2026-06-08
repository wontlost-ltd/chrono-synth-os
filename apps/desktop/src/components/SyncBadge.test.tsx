import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SyncBadge } from './SyncBadge';

describe('SyncBadge', () => {
  it('renders the human label for online_synced', () => {
    render(<SyncBadge state="online_synced" />);
    expect(screen.getByText('Synced')).toBeInTheDocument();
  });

  it('exposes status role + aria-label for screen readers', () => {
    render(<SyncBadge state="conflict_inbox" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Sync status: Conflicts');
  });

  it('falls back gracefully across each defined sync state', () => {
    /* Smoke check that every key in the view map resolves without throwing. */
    const states = [
      'initial_sync',
      'online_synced',
      'online_dirty',
      'syncing',
      'offline_queueing',
      'offline_readonly',
      'conflict_inbox',
      'degraded_remote',
      'reauth_required',
      'recovery_required',
    ] as const;
    for (const s of states) {
      const { unmount } = render(<SyncBadge state={s} />);
      expect(screen.getByRole('status')).toBeInTheDocument();
      unmount();
    }
  });
});
