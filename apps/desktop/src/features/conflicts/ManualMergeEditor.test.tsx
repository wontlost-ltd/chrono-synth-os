/**
 * Manual-merge editor tests — focus on the validation contract since
 * that's what gates submit on ResolutionFooter.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ManualMergeEditor } from './ManualMergeEditor';

function makeConflict(): ConflictInboxItemV1 {
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
    localSummaryParams: { displayName: 'Local', status: 'active' },
    serverSummaryId: 'persona.summary',
    serverSummaryParams: { displayName: 'Server', growthIndex: 100 },
    suggestedActions: ['merge_manually'],
  };
}

describe('ManualMergeEditor', () => {
  it('seeds with a comparison template that parses to null until reserved keys are removed', () => {
    const onChange = vi.fn();
    render(<ManualMergeEditor conflict={makeConflict()} onChange={onChange} />);
    /* The seeded template contains reserved keys (_localValues /
     * _serverValues) that the parser rejects. onChange therefore
     * carries `null` on initial mount — the parent's submit stays
     * gated until the user actually replaces them. */
    const calls = onChange.mock.calls;
    const last = calls[calls.length - 1]?.[0];
    expect(last).toBeNull();
    /* The textarea itself shows the side-by-side template so users
     * can see what's diverging while they construct a real merge. */
    const textarea = screen.getByLabelText(/Merge payload/) as HTMLTextAreaElement;
    expect(textarea.value).toContain('_localValues');
    expect(textarea.value).toContain('_serverValues');
  });

  it('rejects edited payloads that still contain reserved template keys', () => {
    const onChange = vi.fn();
    render(<ManualMergeEditor conflict={makeConflict()} onChange={onChange} />);
    const textarea = screen.getByLabelText(/Merge payload/);
    /* User adds a real key but leaves _localValues / _serverValues
     * around — must NOT be acceptable. */
    fireEvent.change(textarea, {
      target: { value: '{"_localValues":{},"displayName":"Merged"}' },
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('alert')).toHaveTextContent(/seeded template keys|_localValues/i);
  });

  it('reports edited=false initially and edited=true after user changes the textarea', () => {
    const onChange = vi.fn();
    const onEditedChange = vi.fn();
    render(
      <ManualMergeEditor
        conflict={makeConflict()}
        onChange={onChange}
        onEditedChange={onEditedChange}
      />,
    );
    /* Initial mount fires onEditedChange(false). */
    expect(onEditedChange).toHaveBeenCalledWith(false);

    const textarea = screen.getByLabelText(/Merge payload/) as HTMLTextAreaElement;
    const initialValue = textarea.value;
    expect(initialValue.length).toBeGreaterThan(0);

    /* User edits → edited=true. */
    fireEvent.change(textarea, { target: { value: '{"displayName":"Merged"}' } });
    expect(onEditedChange).toHaveBeenLastCalledWith(true);

    /* User restores the original template → edited=false. */
    fireEvent.change(textarea, { target: { value: initialValue } });
    expect(onEditedChange).toHaveBeenLastCalledWith(false);
  });

  it('reports null on invalid JSON', () => {
    const onChange = vi.fn();
    render(<ManualMergeEditor conflict={makeConflict()} onChange={onChange} />);
    const textarea = screen.getByLabelText(/Merge payload/);
    fireEvent.change(textarea, { target: { value: '{not json' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('alert')).toHaveTextContent(/JSON|parse|Unexpected/i);
  });

  it('rejects JSON arrays and primitives (must be an object)', () => {
    const onChange = vi.fn();
    render(<ManualMergeEditor conflict={makeConflict()} onChange={onChange} />);
    const textarea = screen.getByLabelText(/Merge payload/);

    fireEvent.change(textarea, { target: { value: '[1,2,3]' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('alert')).toHaveTextContent('JSON object');

    fireEvent.change(textarea, { target: { value: '"just a string"' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('accepts an edited valid JSON object', () => {
    const onChange = vi.fn();
    render(<ManualMergeEditor conflict={makeConflict()} onChange={onChange} />);
    const textarea = screen.getByLabelText(/Merge payload/);
    fireEvent.change(textarea, { target: { value: '{"displayName":"Merged"}' } });
    expect(onChange).toHaveBeenLastCalledWith({ displayName: 'Merged' });
  });
});
