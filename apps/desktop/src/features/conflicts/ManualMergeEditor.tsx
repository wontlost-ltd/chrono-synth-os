/**
 * Manual-merge editor.
 *
 * When the user picks `merge_manually`, they have to hand-build the
 * resulting payload. The editor:
 *   - Pre-fills the textarea with a deep-merge of local + server
 *     summaryParams (server values win on conflict — same precedence
 *     the rest of the UI assumes). The user can then edit any field.
 *   - Validates that the input parses as a JSON object literal, NOT
 *     an array or primitive. ConflictResolveRequestV1Schema's
 *     superRefine rule will reject non-objects, but giving the user a
 *     parse-time error message is much friendlier than a 400 from the
 *     server.
 *   - Exposes the parsed payload via onChange — null until valid.
 *
 * The submit button on ResolutionFooter is what gates "ready to send";
 * this editor just owns the textarea + validation state.
 */

import { useEffect, useState } from 'react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';

interface ParseResult {
  payload: Record<string, unknown> | null;
  error: string | null;
}

/** Reserved keys from the seeded comparison template. These are not
 *  valid merge-payload field names — the server's SummaryParams schema
 *  would accept them (the API takes `Record<string,unknown>`), so we
 *  reject at the UI boundary instead of relying on server validation. */
const RESERVED_TEMPLATE_KEYS = ['_localValues', '_serverValues'] as const;

function tryParse(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { payload: null, error: 'Payload cannot be empty.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return { payload: null, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { payload: null, error: 'Payload must be a JSON object (not an array or primitive).' };
  }
  /* Reject if any reserved template keys remain. Prevents submitting
   * the seeded comparison template by just adding whitespace to flip
   * `manualMergeEdited` — that bypassed the unedited gate while
   * leaving the payload meaningless. */
  const keys = Object.keys(value);
  const leaked = RESERVED_TEMPLATE_KEYS.filter((k) => keys.includes(k));
  if (leaked.length > 0) {
    return {
      payload: null,
      error: `Remove the seeded template keys (${leaked.join(', ')}) and replace with your merge payload.`,
    };
  }
  return { payload: value as Record<string, unknown>, error: null };
}

function buildInitialPayload(conflict: ConflictInboxItemV1): string {
  /* Seed shows both replicas side-by-side as a JSON template; user
   * MUST edit before submit (gated by `edited` state in the parent).
   * This avoids the data-loss footgun where pre-seeding a valid
   * server-wins payload would let a hurried user resolve as
   * server-wins without realising they accepted that default.
   *
   * The keys (_localValues / _serverValues) are intentionally prefixed
   * with underscores so they're rejected by the server-side
   * SummaryParams schema if the user submits without trimming them —
   * an explicit visible failure beats a silent wrong-side merge. */
  const template = {
    _localValues: conflict.localSummaryParams,
    _serverValues: conflict.serverSummaryParams,
  };
  return JSON.stringify(template, null, 2);
}

export interface ManualMergeEditorProps {
  conflict: ConflictInboxItemV1;
  /** Called whenever the textarea contents parse to a valid object,
   *  with `null` when the current contents are invalid or empty. */
  onChange: (payload: Record<string, unknown> | null) => void;
  /** Called with `true` once the user has changed the textarea from
   *  the seeded template. The parent disables Submit until edited so
   *  hitting Resolve without thinking can't silently apply the
   *  template-as-payload (which has _localValues/_serverValues keys
   *  the server would reject anyway, but the UX is clearer this way). */
  onEditedChange?: (edited: boolean) => void;
}

export function ManualMergeEditor({ conflict, onChange, onEditedChange }: ManualMergeEditorProps) {
  const [raw, setRaw] = useState(() => buildInitialPayload(conflict));
  const [initialValue, setInitialValue] = useState(() => buildInitialPayload(conflict));
  const [error, setError] = useState<string | null>(null);

  /* Reset textarea when the conflict id changes (user navigated to a
   * different conflict without unmounting the editor). */
  useEffect(() => {
    const initial = buildInitialPayload(conflict);
    setRaw(initial);
    setInitialValue(initial);
    const parsed = tryParse(initial);
    setError(parsed.error);
    onChange(parsed.payload);
    onEditedChange?.(false);
    /* `onChange` / `onEditedChange` are captured but stable in
     * practice (parent uses useCallback). Excluding from deps so we
     * don't re-fire on every parent render. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict.conflictId]);

  const handleChange = (next: string): void => {
    setRaw(next);
    const parsed = tryParse(next);
    setError(parsed.error);
    onChange(parsed.payload);
    onEditedChange?.(next !== initialValue);
  };

  return (
    <div className="space-y-2">
      <label
        htmlFor="manual-merge-payload"
        className="block text-xs font-medium uppercase tracking-wider text-chrono-text-tertiary"
      >
        Merge payload (JSON object)
      </label>
      <textarea
        id="manual-merge-payload"
        rows={10}
        spellCheck={false}
        value={raw}
        onChange={(event) => handleChange(event.target.value)}
        className="w-full rounded-md border border-chrono-border bg-chrono-elevated p-3 font-mono text-xs text-chrono-text-primary focus:border-chrono-accent focus:outline-none"
        aria-invalid={error !== null}
        aria-describedby={error ? 'manual-merge-error' : undefined}
      />
      {error && (
        <p
          id="manual-merge-error"
          role="alert"
          className="text-xs text-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
