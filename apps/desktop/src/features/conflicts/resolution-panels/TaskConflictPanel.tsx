/**
 * Task conflict — marketplace task lifecycle differences:
 *   title, status (open/accepted/completed/cancelled), category, reward,
 *   acceptedBy, deadline
 *
 * The most common conflict here is "both sides accepted by different
 * personas in parallel" — manifests as different `acceptedBy` values.
 * Server-side wins by default to avoid double-paying rewards, but the
 * UI surfaces the divergence in case the user explicitly wants to keep
 * the local acceptance (e.g. they accepted offline first).
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ParamComparator } from './shared';

const TASK_FIELDS = [
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'category', label: 'Category' },
  { id: 'reward', label: 'Reward' },
  { id: 'acceptedBy', label: 'Accepted by' },
  { id: 'deadline', label: 'Deadline' },
];

export function TaskConflictPanel({ conflict }: { conflict: ConflictInboxItemV1 }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-chrono-text-secondary">
        Task <span className="font-mono">{conflict.entityId}</span> has
        conflicting acceptance / status state. If the divergence is on
        <code className="mx-1 rounded bg-chrono-surface px-1">acceptedBy</code>,
        prefer the server side unless you accepted offline first.
      </p>
      <ParamComparator fields={TASK_FIELDS} conflict={conflict} />
    </div>
  );
}
