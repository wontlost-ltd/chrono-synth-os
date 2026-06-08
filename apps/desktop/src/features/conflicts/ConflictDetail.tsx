/**
 * Conflict detail — right pane.
 *
 * Composes the per-type ResolutionPanel + ManualMergeEditor (conditional)
 * + ResolutionFooter, and owns the local resolution state (selected
 * action, manual-merge payload, in-flight + error state).
 *
 * Telemetry is fired at three points:
 *   - on mount (`conflict.view`)
 *   - immediately on submit (`conflict.resolve.attempt`)
 *   - after the network round-trip (`conflict.resolve.complete` with
 *     outcome + durationMs)
 *
 * On a 409 (version conflict — someone else already resolved this), the
 * UI bubbles up an `onStale` callback so the parent can refresh the
 * list. We do not auto-retry because the resolution choice may have
 * been invalidated by the other side's action.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { getHttpStatus, resolveConflict } from './conflict-api';
import { emitConflictTelemetry } from '../../telemetry/conflicts';
import { ManualMergeEditor } from './ManualMergeEditor';
import { ResolutionFooter } from './ResolutionFooter';
import { PersonaConflictPanel } from './resolution-panels/PersonaConflictPanel';
import { MemoryConflictPanel } from './resolution-panels/MemoryConflictPanel';
import { TaskConflictPanel } from './resolution-panels/TaskConflictPanel';
import { DeviceConflictPanel } from './resolution-panels/DeviceConflictPanel';
import { PolicyConflictPanel } from './resolution-panels/PolicyConflictPanel';

type Action = 'keep_local' | 'keep_server' | 'duplicate' | 'merge_manually';

function classifyError(err: unknown): 'version_conflict' | 'network_error' | 'validation_error' {
  /* Exact status parse via apiFetch's "HTTP NNN" message prefix.
   * 409 = ifMatch mismatch → stale-refresh path.
   * Other 4xx (400/401/403/404) = validation / auth / not-found → surface
   *   to the user as an actionable error, do NOT silently refresh.
   * 5xx + network failures → generic network_error. */
  const status = getHttpStatus(err);
  if (status === 409) return 'version_conflict';
  if (status !== null && status >= 400 && status < 500) return 'validation_error';
  return 'network_error';
}

/** nowMs() fallback for embedded runtimes where the API
 *  doesn't exist (older Tauri webviews / non-DOM test environments).
 *  Date.now() is millisecond-accurate so SEQ time-on-task numbers stay
 *  comparable across both code paths. */
function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function PanelFor({ conflict }: { conflict: ConflictInboxItemV1 }) {
  /* Dispatch by entityType to the type-specific panel. The contract
   * union is closed (5 entries) so the switch is exhaustive. */
  switch (conflict.entityType) {
    case 'persona':
      return <PersonaConflictPanel conflict={conflict} />;
    case 'memory':
      return <MemoryConflictPanel conflict={conflict} />;
    case 'task':
      return <TaskConflictPanel conflict={conflict} />;
    case 'device':
      return <DeviceConflictPanel conflict={conflict} />;
    case 'policy':
      return <PolicyConflictPanel conflict={conflict} />;
  }
}

export interface ConflictDetailProps {
  conflict: ConflictInboxItemV1;
  onResolved: () => void;
  onStale: () => void;
}

export function ConflictDetail({ conflict, onResolved, onStale }: ConflictDetailProps) {
  const [selectedAction, setSelectedAction] = useState<Action | null>(null);
  const [mergePayload, setMergePayload] = useState<Record<string, unknown> | null>(null);
  const [manualMergeEdited, setManualMergeEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /* Reset internal state when the selected conflict changes. */
  useEffect(() => {
    setSelectedAction(null);
    setMergePayload(null);
    setManualMergeEdited(false);
    setSubmitting(false);
    setErrorMessage(null);
    emitConflictTelemetry({
      kind: 'conflict.view',
      entityType: conflict.entityType,
      severity: conflict.severity,
    });
  }, [conflict.conflictId, conflict.entityType, conflict.severity]);

  const onSubmit = useCallback(async () => {
    if (!selectedAction) return;
    const startedAt = nowMs();
    setSubmitting(true);
    setErrorMessage(null);

    emitConflictTelemetry({
      kind: 'conflict.resolve.attempt',
      entityType: conflict.entityType,
      action: selectedAction,
    });

    try {
      await resolveConflict({
        conflictId: conflict.conflictId,
        ifMatch: conflict.conflictVersion,
        action: selectedAction,
        /* mergePayload is required only when action === merge_manually.
         * Spread conditionally so the contract's superRefine doesn't
         * fail on an empty `mergePayload: {}` from the wrong branch. */
        ...(selectedAction === 'merge_manually' && mergePayload !== null
          ? { mergePayload }
          : {}),
      });

      emitConflictTelemetry({
        kind: 'conflict.resolve.complete',
        entityType: conflict.entityType,
        action: selectedAction,
        outcome: 'success',
        durationMs: Math.round(nowMs() - startedAt),
      });
      onResolved();
    } catch (err) {
      const outcome = classifyError(err);
      emitConflictTelemetry({
        kind: 'conflict.resolve.complete',
        entityType: conflict.entityType,
        action: selectedAction,
        outcome,
        durationMs: Math.round(nowMs() - startedAt),
      });
      if (outcome === 'version_conflict') {
        onStale();
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [conflict, selectedAction, mergePayload, onResolved, onStale]);

  return (
    <article aria-label={`Conflict ${conflict.conflictId}`} className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-chrono-text-primary">
            {conflict.entityType[0]?.toUpperCase()}{conflict.entityType.slice(1)} conflict
          </h2>
          <p className="mt-1 text-xs text-chrono-text-tertiary">
            Detected {new Date(conflict.detectedAt).toLocaleString()} · severity {conflict.severity}
          </p>
        </div>
        <span className="rounded-full bg-chrono-elevated px-3 py-1 text-[11px] font-mono text-chrono-text-tertiary">
          {conflict.conflictId}
        </span>
      </header>

      <PanelFor conflict={conflict} />

      {selectedAction === 'merge_manually' && (
        <ManualMergeEditor
          conflict={conflict}
          onChange={setMergePayload}
          onEditedChange={setManualMergeEdited}
        />
      )}

      <ResolutionFooter
        conflict={conflict}
        selectedAction={selectedAction}
        onSelectAction={setSelectedAction}
        manualMergeInvalid={selectedAction === 'merge_manually' && mergePayload === null}
        manualMergeEdited={manualMergeEdited}
        submitting={submitting}
        onSubmit={() => { void onSubmit(); }}
      />

      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-error/40 bg-error/5 p-3 text-xs text-error"
        >
          {errorMessage}
        </div>
      )}
    </article>
  );
}
