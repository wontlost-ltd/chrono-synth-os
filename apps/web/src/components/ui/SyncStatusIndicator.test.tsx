import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RuntimeSyncStateV2Values } from '@chrono/contracts';
import { SyncStatusIndicator } from './SyncStatusIndicator';

describe('SyncStatusIndicator', () => {
  it('renders initial_sync status', () => {
    render(<SyncStatusIndicator state="initial_sync" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders offline_queueing with pending count', () => {
    render(<SyncStatusIndicator state="offline_queueing" pendingCount={3} />);
    expect(screen.getByRole('status')).toHaveTextContent('3');
  });

  it('has a non-empty aria-label for degraded_remote state', () => {
    render(<SyncStatusIndicator state="degraded_remote" />);
    expect(screen.getByRole('status')).toHaveAccessibleName(/.+/);
  });

  it.each(RuntimeSyncStateV2Values.map(s => ({ state: s })))('renders $state', ({ state }) => {
    render(<SyncStatusIndicator state={state} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not show pending count when pendingCount is 0', () => {
    render(<SyncStatusIndicator state="offline_queueing" pendingCount={0} />);
    expect(screen.getByRole('status')).not.toHaveTextContent('(0)');
  });

  it('applies custom className prop', () => {
    render(<SyncStatusIndicator state="online_synced" className="test-cls" />);
    expect(screen.getByRole('status')).toHaveClass('test-cls');
  });
});
