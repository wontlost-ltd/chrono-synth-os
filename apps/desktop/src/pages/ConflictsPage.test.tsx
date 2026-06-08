import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConflictsPage } from './ConflictsPage';

vi.mock('../bridge/tauri-commands', () => ({
  queryPersonas: vi.fn(),
  getSyncState: vi.fn(),
  crdtGetPersonaState: vi.fn(),
  forceSync: vi.fn(),
}));

/* Stub the conflict-inbox API so these tests can focus on the CRDT
 * inspector half of ConflictsPage. The conflict-inbox feature has
 * dedicated tests under src/features/conflicts/. */
vi.mock('../features/conflicts/conflict-api', () => ({
  listConflicts: vi.fn(),
  resolveConflict: vi.fn(),
  getConflict: vi.fn(),
}));

import {
  queryPersonas,
  getSyncState,
  crdtGetPersonaState,
  forceSync,
} from '../bridge/tauri-commands';
import { listConflicts } from '../features/conflicts/conflict-api';

const queryPersonasMock = queryPersonas as unknown as ReturnType<typeof vi.fn>;
const getSyncStateMock = getSyncState as unknown as ReturnType<typeof vi.fn>;
const crdtGetPersonaStateMock = crdtGetPersonaState as unknown as ReturnType<typeof vi.fn>;
const forceSyncMock = forceSync as unknown as ReturnType<typeof vi.fn>;
const listConflictsMock = listConflicts as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryPersonasMock.mockReset();
  getSyncStateMock.mockReset();
  crdtGetPersonaStateMock.mockReset();
  forceSyncMock.mockReset();
  listConflictsMock.mockReset();
  /* Default: no conflicts, no error — keeps existing CRDT-focused
   * tests isolated from the inbox surface. */
  listConflictsMock.mockResolvedValue([]);
});

describe('ConflictsPage', () => {
  it('renders heading + subtitle', async () => {
    queryPersonasMock.mockResolvedValue([]);
    getSyncStateMock.mockResolvedValue({
      id: 'singleton',
      state: 'online_synced',
      network_online: true,
      auth_valid: true,
      remote_reachable: true,
      pending_push_count: 0,
      conflict_count: 0,
      last_sync_at: null,
      last_error: null,
      updated_at: Date.now(),
    });
    render(<ConflictsPage />);
    expect(screen.getByRole('heading', { name: 'Conflict Inbox' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/No personas to inspect/)).toBeInTheDocument();
    });
  });

  it('lists personas with CRDT field state', async () => {
    queryPersonasMock.mockResolvedValue([
      {
        persona_id: 'p_42',
        display_name: 'Alice',
        status: 'active',
        visibility: 'private',
        growth_index: 0.3,
        reputation: 0.5,
        wallet_id: null,
        wallet_balance: null,
        updated_at: '2026-05-23T00:00:00Z',
        synced_at: 0,
      },
    ]);
    getSyncStateMock.mockResolvedValue({
      id: 'singleton',
      state: 'online_synced',
      network_online: true,
      auth_valid: true,
      remote_reachable: true,
      pending_push_count: 0,
      conflict_count: 0,
      last_sync_at: 1716480000000,
      last_error: null,
      updated_at: 1716480000000,
    });
    crdtGetPersonaStateMock.mockResolvedValue({
      persona_id: 'p_42',
      fields: { display_name: 'Alice', growth_index: 0.7 },
    });

    render(<ConflictsPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument();
    });
    expect(screen.getByText('p_42')).toBeInTheDocument();
    expect(screen.getByText('display_name:')).toBeInTheDocument();
    expect(screen.getByText('growth_index:')).toBeInTheDocument();
  });

  it('triggers force sync when the button is clicked', async () => {
    queryPersonasMock.mockResolvedValue([]);
    getSyncStateMock.mockResolvedValue({
      id: 'singleton',
      state: 'online_synced',
      network_online: true,
      auth_valid: true,
      remote_reachable: true,
      pending_push_count: 2,
      conflict_count: 0,
      last_sync_at: null,
      last_error: null,
      updated_at: Date.now(),
    });
    forceSyncMock.mockResolvedValue(undefined);

    render(<ConflictsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Force sync' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Force sync' }));

    await waitFor(() => {
      expect(forceSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces backend errors as an alert', async () => {
    queryPersonasMock.mockRejectedValue(new Error('database lock poisoned'));
    getSyncStateMock.mockResolvedValue({
      id: 'singleton',
      state: 'idle',
      network_online: true,
      auth_valid: true,
      remote_reachable: false,
      pending_push_count: 0,
      conflict_count: 0,
      last_sync_at: null,
      last_error: null,
      updated_at: Date.now(),
    });

    render(<ConflictsPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('database lock poisoned');
    });
  });
});
