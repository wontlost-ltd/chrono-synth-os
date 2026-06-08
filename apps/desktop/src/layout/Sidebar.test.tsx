import { describe, it, expect, vi } from 'vitest';

/* Sidebar uses useSyncState(). We mock the hook to a deterministic
 * value so each test controls the conflict counter. */
vi.mock('@/hooks/useSyncState', () => ({
  useSyncState: vi.fn(() => ({ data: { state: 'online_synced', conflict_count: 0 } })),
}));

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useSyncState } from '@/hooks/useSyncState';

function renderInRouter() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Sidebar />
    </MemoryRouter>
  );
}

describe('Sidebar', () => {
  it('exposes the navigation as a primary landmark', () => {
    renderInRouter();
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toBeInTheDocument();
  });

  it('renders all 6 navigation labels', () => {
    renderInRouter();
    for (const label of ['Personas', 'Conflicts', 'AI Safety', 'Approvals', 'Google Auth', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('does not show a conflict counter when count is 0', () => {
    renderInRouter();
    expect(screen.queryByLabelText(/conflicts pending/)).not.toBeInTheDocument();
  });

  it('shows the conflict counter with aria-label when conflicts exist', () => {
    vi.mocked(useSyncState).mockReturnValueOnce({
      data: { state: 'conflict_inbox', conflict_count: 3 },
    } as ReturnType<typeof useSyncState>);
    renderInRouter();
    expect(screen.getByLabelText('3 conflicts pending')).toBeInTheDocument();
  });
});
