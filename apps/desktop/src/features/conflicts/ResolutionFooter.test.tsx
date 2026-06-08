/**
 * ResolutionFooter tests — the gate that prevents invalid submits.
 *
 * The critical invariants:
 *   - Submit disabled when no action selected.
 *   - Submit disabled when manual-merge selected but payload invalid.
 *   - Submit enabled when keep_local / keep_server / duplicate selected.
 *   - Suggested-action labels appear ONLY on actions in suggestedActions.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ResolutionFooter } from './ResolutionFooter';

function makeConflict(suggested: ConflictInboxItemV1['suggestedActions']): ConflictInboxItemV1 {
  return {
    schemaVersion: 'conflict-inbox.v1',
    conflictId: 'c-1',
    conflictVersion: 'v-1',
    tenantId: 't-1',
    entityType: 'persona',
    entityId: 'e-1',
    sourceRuntime: 'desktop',
    detectedAt: '2026-05-23T00:00:00Z',
    severity: 'blocking',
    localSummaryId: 'persona.summary',
    localSummaryParams: {},
    serverSummaryId: 'persona.summary',
    serverSummaryParams: {},
    suggestedActions: suggested,
  };
}

describe('ResolutionFooter', () => {
  it('disables submit when no action is selected', () => {
    render(
      <ResolutionFooter
        conflict={makeConflict(['keep_local', 'keep_server'])}
        selectedAction={null}
        onSelectAction={() => {}}
        manualMergeInvalid={false}
        manualMergeEdited={false}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Resolve/ })).toBeDisabled();
  });

  it('enables submit on simple action selection', () => {
    render(
      <ResolutionFooter
        conflict={makeConflict(['keep_local'])}
        selectedAction="keep_local"
        onSelectAction={() => {}}
        manualMergeInvalid={false}
        manualMergeEdited={false}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Resolve/ })).toBeEnabled();
  });

  it('keeps submit disabled while manual-merge payload is invalid', () => {
    render(
      <ResolutionFooter
        conflict={makeConflict(['merge_manually'])}
        selectedAction="merge_manually"
        onSelectAction={() => {}}
        manualMergeInvalid={true}
        manualMergeEdited={false}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Resolve/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/JSON object/);
  });

  it('blocks submit when manual-merge is valid but unedited (template untouched)', () => {
    render(
      <ResolutionFooter
        conflict={makeConflict(['merge_manually'])}
        selectedAction="merge_manually"
        onSelectAction={() => {}}
        manualMergeInvalid={false}
        manualMergeEdited={false}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Resolve/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Edit the merge payload/);
  });

  it('allows submit once manual-merge payload is valid AND edited', () => {
    render(
      <ResolutionFooter
        conflict={makeConflict(['merge_manually'])}
        selectedAction="merge_manually"
        onSelectAction={() => {}}
        manualMergeInvalid={false}
        manualMergeEdited={true}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Resolve/ })).toBeEnabled();
  });

  it('marks suggested actions with the Suggested badge', () => {
    render(
      <ResolutionFooter
        conflict={makeConflict(['keep_server', 'merge_manually'])}
        selectedAction={null}
        onSelectAction={() => {}}
        manualMergeInvalid={false}
        manualMergeEdited={false}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    /* "Keep server" row should have a Suggested badge. */
    const keepServerLabel = screen.getByText('Keep server').closest('label');
    expect(keepServerLabel).toBeTruthy();
    expect(within(keepServerLabel!).getByText('Suggested')).toBeInTheDocument();
    /* "Keep local" should NOT have a Suggested badge. */
    const keepLocalLabel = screen.getByText('Keep local').closest('label');
    expect(within(keepLocalLabel!).queryByText('Suggested')).toBeNull();
  });

  it('fires onSelectAction when the user picks a radio', () => {
    const onSelect = vi.fn();
    render(
      <ResolutionFooter
        conflict={makeConflict(['keep_local'])}
        selectedAction={null}
        onSelectAction={onSelect}
        manualMergeInvalid={false}
        manualMergeEdited={false}
        submitting={false}
        onSubmit={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Keep local/));
    expect(onSelect).toHaveBeenCalledWith('keep_local');
  });
});
