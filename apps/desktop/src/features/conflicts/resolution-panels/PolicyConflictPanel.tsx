/**
 * Policy conflict — governance / safety policy divergence:
 *   policyName, version, scope, effect (allow/deny), createdBy, expiresAt
 *
 * Policies are the highest-stakes conflict class — picking the wrong
 * side can disable a kill switch or re-enable a flagged feature. The
 * panel deliberately surfaces `effect` and `version` first so the user
 * sees what they're choosing at a glance.
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ParamComparator } from './shared';

const POLICY_FIELDS = [
  { id: 'policyName', label: 'Policy name' },
  { id: 'effect', label: 'Effect' },
  { id: 'version', label: 'Version' },
  { id: 'scope', label: 'Scope' },
  { id: 'createdBy', label: 'Created by' },
  { id: 'expiresAt', label: 'Expires' },
];

export function PolicyConflictPanel({ conflict }: { conflict: ConflictInboxItemV1 }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-error/40 bg-error/5 p-3 text-xs text-error">
        <p className="font-semibold">Policy conflicts are high-stakes.</p>
        <p className="mt-1 text-error/80">
          Picking the wrong side can disable a kill switch or re-enable a
          flagged feature. If unsure, escalate to a governance reviewer
          before resolving.
        </p>
      </div>
      <p className="text-xs text-chrono-text-secondary">
        Policy <span className="font-mono">{conflict.entityId}</span> diverged
        between replicas.
      </p>
      <ParamComparator fields={POLICY_FIELDS} conflict={conflict} />
    </div>
  );
}
