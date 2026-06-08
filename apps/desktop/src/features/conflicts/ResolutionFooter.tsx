/**
 * Resolution footer — the 4-action radio + submit button under each
 * conflict-detail panel.
 *
 * Why a radio + separate submit instead of 4 click-to-resolve buttons:
 *   - Resolving a conflict is irreversible. Forcing an explicit submit
 *     means a single misclick on "keep server" can't blow away a
 *     long-offline local edit.
 *   - The contract requires `mergePayload` when action is
 *     `merge_manually`. The footer disables submit until the payload is
 *     valid, so the UI cannot trigger a 4xx schema validation error.
 *
 * Suggested actions come from the server — if `merge_manually` is not
 * in `suggestedActions` for a conflict (e.g. a CONCURRENT_DELETE class
 * has no meaningful merge), it's hidden. The user can still see all 4
 * for transparency via the `showAllActions` toggle.
 */

import { useId } from 'react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';

type Action = 'keep_local' | 'keep_server' | 'duplicate' | 'merge_manually';

const ACTION_LABELS: Record<Action, { title: string; description: string }> = {
  keep_local: {
    title: 'Keep local',
    description: 'Discard the server side. The next sync push will overwrite the server with the local replica.',
  },
  keep_server: {
    title: 'Keep server',
    description: 'Discard the local side. The next sync pull will reset the local replica to the server value.',
  },
  duplicate: {
    title: 'Keep both',
    description: 'Create a new entity with the local values and keep the server-side entity untouched.',
  },
  merge_manually: {
    title: 'Merge manually',
    description: 'Construct a new payload combining fields from both sides. Required for non-trivial merges.',
  },
};

export interface ResolutionFooterProps {
  conflict: ConflictInboxItemV1;
  selectedAction: Action | null;
  onSelectAction: (action: Action) => void;
  /** True when manual-merge is currently selected AND the payload is
   *  invalid (empty / not a JSON object). Disables submit. */
  manualMergeInvalid: boolean;
  /** True when the user has actually changed the manual-merge textarea
   *  from the seeded template. Combined with `manualMergeInvalid` this
   *  prevents accidental "Submit unchanged template" footguns — the
   *  seeded template contains _localValues/_serverValues keys so even
   *  if submitted, the server would 400 it, but failing in the UI is
   *  clearer than a server roundtrip.
   *  Only consulted when selectedAction === 'merge_manually'. */
  manualMergeEdited: boolean;
  submitting: boolean;
  onSubmit: () => void;
}

export function ResolutionFooter({
  conflict,
  selectedAction,
  onSelectAction,
  manualMergeInvalid,
  manualMergeEdited,
  submitting,
  onSubmit,
}: ResolutionFooterProps) {
  const radioGroupId = useId();
  const suggested = new Set(conflict.suggestedActions);

  /* Submit is disabled when:
   *   - no action selected, OR
   *   - action is merge_manually AND (payload invalid OR template unedited), OR
   *   - a previous submit is still in flight. */
  const manualMergeBlocked =
    selectedAction === 'merge_manually' &&
    (manualMergeInvalid || !manualMergeEdited);
  const canSubmit = selectedAction !== null && !submitting && !manualMergeBlocked;

  return (
    <div className="mt-6 space-y-4 rounded-lg border border-chrono-border bg-chrono-surface p-4">
      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wider text-chrono-text-tertiary">
          Resolution
        </legend>
        <div className="mt-2 space-y-2">
          {(['keep_local', 'keep_server', 'duplicate', 'merge_manually'] as Action[]).map((action) => {
            const isSuggested = suggested.has(action);
            return (
              <label
                key={action}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors ${
                  selectedAction === action
                    ? 'border-chrono-accent bg-chrono-accent/5'
                    : 'border-chrono-border hover:bg-chrono-elevated/50'
                }`}
              >
                <input
                  type="radio"
                  name={radioGroupId}
                  value={action}
                  checked={selectedAction === action}
                  onChange={() => onSelectAction(action)}
                  className="mt-1"
                />
                <span className="flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-medium text-chrono-text-primary">
                      {ACTION_LABELS[action].title}
                    </span>
                    {isSuggested && (
                      <span className="rounded-full bg-chrono-accent/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-chrono-accent">
                        Suggested
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-chrono-text-secondary">
                    {ACTION_LABELS[action].description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {selectedAction === 'merge_manually' && manualMergeInvalid && (
          <p className="text-xs text-error" role="alert" aria-live="polite">
            Provide a valid JSON object before submitting.
          </p>
        )}
        {selectedAction === 'merge_manually' && !manualMergeInvalid && !manualMergeEdited && (
          <p className="text-xs text-chrono-text-secondary" role="status" aria-live="polite">
            Edit the merge payload before submitting — the seeded template is not a valid resolution.
          </p>
        )}
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="rounded-md bg-chrono-accent px-4 py-2 text-sm font-medium text-white hover:bg-chrono-accent/90 disabled:opacity-50"
        >
          {submitting ? 'Resolving…' : 'Resolve'}
        </button>
      </div>
    </div>
  );
}
