/* GA Sprint 3 Step 12 — conflict inbox + CRDT inspector.
 *
 * Two surfaces in one route:
 *   1. **Conflict inbox** (top) — fetches `/api/v1/conflicts` from the
 *      configured chrono-synth-os instance and lets the user resolve
 *      blocking + warning conflicts across all 5 entity types
 *      (persona / memory / task / device / policy). The per-type
 *      ResolutionPanels know which summary fields matter for each
 *      class; ResolutionFooter gates the 4-action submit.
 *   2. **CRDT inspector** (bottom) — local-only view of per-persona
 *      Yjs field state, with force-sync. Carried over from the
 *      Sprint 3 r1 version so operators retain the existing
 *      diagnostic tool.
 *
 * Why both on one page:
 *   The two surfaces answer related questions ("why am I divergent?"
 *   vs. "what divergence is the server tracking right now?") and
 *   live together in the user's mental model. Splitting them across
 *   routes pushes operators into hunting through the nav.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';
import {
  crdtGetPersonaState,
  forceSync,
  getSyncState,
  queryPersonas,
  type PersonaCrdtState,
  type PersonaRow,
  type SyncStateRow,
} from '../bridge/tauri-commands';
import { ApiNotConfiguredError } from '../bridge/http-client';
import { ConflictList } from '../features/conflicts/ConflictList';
import { ConflictDetail } from '../features/conflicts/ConflictDetail';
import { listConflicts } from '../features/conflicts/conflict-api';

interface CrdtRow {
  persona: PersonaRow;
  crdt: PersonaCrdtState | null;
  error: string | null;
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function ConflictsPage() {
  /* ── Conflict inbox state ─────────────────────────────────────── */
  const [conflicts, setConflicts] = useState<ConflictInboxItemV1[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [conflictsError, setConflictsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* ── CRDT inspector state (preserved from Sprint 3 r1) ────────── */
  const [crdtRows, setCrdtRows] = useState<CrdtRow[]>([]);
  const [syncState, setSyncState] = useState<SyncStateRow | null>(null);
  const [crdtLoading, setCrdtLoading] = useState(true);
  const [crdtError, setCrdtError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /* request-sequence guard: monotonic counter — only the latest
   * loadCrdt() is allowed to write state. Prevents older overlapping
   * loads from clobbering newer ones. */
  const crdtSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadConflicts = useCallback(async () => {
    if (mountedRef.current) {
      setConflictsLoading(true);
      setConflictsError(null);
    }
    try {
      const items = await listConflicts();
      if (!mountedRef.current) return;
      setConflicts(items);
      /* Auto-select the first conflict on initial load only. After the
       * list refreshes (e.g. post-resolve), keep the current selection
       * if it still exists; otherwise pick the first one. */
      setSelectedId((current) => {
        if (current && items.some((c) => c.conflictId === current)) return current;
        return items[0]?.conflictId ?? null;
      });
    } catch (err) {
      if (!mountedRef.current) return;
      /* "Not configured" is a benign state — the user just hasn't
       * pointed this install at an OS yet. Surface a friendlier
       * message instead of the raw error. */
      if (err instanceof ApiNotConfiguredError) {
        setConflictsError('Chrono Synth API not configured. Set base URL + token under Settings to load the conflict inbox.');
      } else {
        setConflictsError(err instanceof Error ? err.message : String(err));
      }
      setConflicts([]);
      setSelectedId(null);
    } finally {
      if (mountedRef.current) setConflictsLoading(false);
    }
  }, []);

  const loadCrdt = useCallback(async () => {
    const seq = ++crdtSeqRef.current;
    if (mountedRef.current) {
      setCrdtLoading(true);
      setCrdtError(null);
    }
    try {
      const [personas, currentSync] = await Promise.all([
        queryPersonas(),
        getSyncState(),
      ]);
      if (!mountedRef.current || seq !== crdtSeqRef.current) return;
      setSyncState(currentSync);

      const enriched = await Promise.all(
        personas.map(async (persona) => {
          try {
            const crdt = await crdtGetPersonaState(persona.persona_id);
            return { persona, crdt, error: null };
          } catch (err) {
            return {
              persona,
              crdt: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      if (!mountedRef.current || seq !== crdtSeqRef.current) return;
      setCrdtRows(enriched);
    } catch (err) {
      if (!mountedRef.current || seq !== crdtSeqRef.current) return;
      setCrdtError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && seq === crdtSeqRef.current) {
        setCrdtLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadConflicts();
    void loadCrdt();
  }, [loadConflicts, loadCrdt]);

  const triggerSync = useCallback(async () => {
    if (!mountedRef.current) return;
    setSyncing(true);
    setCrdtError(null);
    try {
      await forceSync();
      if (!mountedRef.current) return;
      await loadCrdt();
    } catch (err) {
      if (!mountedRef.current) return;
      setCrdtError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSyncing(false);
    }
  }, [loadCrdt]);

  const selectedConflict =
    conflicts.find((c) => c.conflictId === selectedId) ?? null;

  return (
    <section className="space-y-10">
      {/* ── Conflict inbox ───────────────────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-chrono-text-primary">
              Conflict Inbox
            </h1>
            <p className="mt-1 text-sm text-chrono-text-secondary">
              Resolve sync divergence across personas, memories, tasks,
              devices, and policies. Pick a side, duplicate, or build a
              manual merge payload.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void loadConflicts(); }}
            disabled={conflictsLoading}
            className="rounded-md border border-chrono-border px-3 py-1.5 text-xs font-medium text-chrono-text-secondary hover:bg-chrono-surface disabled:opacity-60"
          >
            Refresh
          </button>
        </div>

        {conflictsError && (
          <div
            role="alert"
            aria-live="polite"
            className="mt-4 rounded-lg border border-error/40 bg-error/5 p-4 text-sm text-error"
          >
            {conflictsError}
          </div>
        )}

        <div className="mt-4 grid gap-4 md:grid-cols-[18rem_1fr]">
          <aside className="rounded-lg border border-chrono-border bg-chrono-elevated p-3">
            {conflictsLoading ? (
              <p className="px-3 py-6 text-center text-xs text-chrono-text-tertiary">
                Loading…
              </p>
            ) : (
              <ConflictList
                conflicts={conflicts}
                selectedConflictId={selectedId}
                onSelect={(c) => setSelectedId(c.conflictId)}
              />
            )}
          </aside>
          <div className="rounded-lg border border-chrono-border bg-chrono-elevated p-5">
            {selectedConflict ? (
              <ConflictDetail
                conflict={selectedConflict}
                onResolved={() => { void loadConflicts(); }}
                onStale={() => { void loadConflicts(); }}
              />
            ) : (
              <p className="text-sm text-chrono-text-tertiary">
                {conflicts.length === 0
                  ? 'No conflicts to resolve.'
                  : 'Select a conflict from the left to begin.'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── CRDT inspector (secondary diagnostic) ─────────────────── */}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-chrono-text-primary">
              CRDT field state
            </h2>
            <p className="mt-1 text-sm text-chrono-text-secondary">
              Per-persona Yjs field snapshot — verify field-level merges
              and force a push if Yjs updates are stuck locally.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void triggerSync(); }}
            disabled={syncing}
            className="rounded-md bg-chrono-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-chrono-accent/90 disabled:opacity-60"
          >
            {syncing ? 'Syncing…' : 'Force sync'}
          </button>
        </div>

        {syncState && (
          <div className="mt-4 grid gap-2 rounded-lg border border-chrono-border bg-chrono-elevated p-4 text-xs text-chrono-text-secondary md:grid-cols-2">
            <div>
              <span className="font-medium text-chrono-text-primary">State:</span>{' '}
              {syncState.state}
            </div>
            <div>
              <span className="font-medium text-chrono-text-primary">Pending push:</span>{' '}
              {syncState.pending_push_count}
            </div>
            <div>
              <span className="font-medium text-chrono-text-primary">Conflicts:</span>{' '}
              {syncState.conflict_count}
            </div>
            <div>
              <span className="font-medium text-chrono-text-primary">Last sync:</span>{' '}
              {formatTimestamp(syncState.last_sync_at)}
            </div>
            {syncState.last_error && (
              <div className="md:col-span-2 text-error">
                <span className="font-medium">Last error:</span> {syncState.last_error}
              </div>
            )}
          </div>
        )}

        {crdtError && (
          <div
            role="alert"
            aria-live="polite"
            className="mt-4 rounded-lg border border-error/40 bg-error/5 p-4 text-sm text-error"
          >
            {crdtError}
          </div>
        )}

        <div className="mt-6">
          {crdtLoading ? (
            <p className="text-sm text-chrono-text-secondary">Loading personas…</p>
          ) : crdtRows.length === 0 ? (
            <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-8 text-center">
              <p className="text-sm text-chrono-text-secondary">
                No personas to inspect.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {crdtRows.map(({ persona, crdt, error: rowError }) => (
                <li
                  key={persona.persona_id}
                  className="rounded-lg border border-chrono-border bg-chrono-elevated p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-chrono-text-primary">
                      {persona.display_name}
                    </h3>
                    <span className="font-mono text-xs text-chrono-text-tertiary">
                      {persona.persona_id}
                    </span>
                  </div>
                  {rowError ? (
                    <p className="mt-2 text-xs text-error">{rowError}</p>
                  ) : crdt && Object.keys(crdt.fields).length === 0 ? (
                    <p className="mt-2 text-xs text-chrono-text-tertiary">
                      No CRDT field state — persona uses LWW path only.
                    </p>
                  ) : crdt ? (
                    <dl className="mt-2 grid gap-1 text-xs md:grid-cols-2">
                      {Object.entries(crdt.fields).map(([field, value]) => (
                        <div key={field} className="flex items-baseline gap-2">
                          <dt className="font-medium text-chrono-text-secondary">{field}:</dt>
                          <dd className="break-words text-chrono-text-primary">
                            {typeof value === 'string' ? value : JSON.stringify(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
