/**
 * Persona conflict — typical fields:
 *   displayName, status, visibility, growthIndex, reputation, walletBalance
 *
 * Local & server values surface as a two-column comparator so the user
 * can identify which field actually diverged (e.g. growth-index drift
 * after a long offline window vs. a deliberate status change).
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ParamComparator } from './shared';

const PERSONA_FIELDS = [
  { id: 'displayName', label: 'Display name' },
  { id: 'status', label: 'Status' },
  { id: 'visibility', label: 'Visibility' },
  { id: 'growthIndex', label: 'Growth index' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'walletBalance', label: 'Wallet balance' },
];

export function PersonaConflictPanel({ conflict }: { conflict: ConflictInboxItemV1 }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-chrono-text-secondary">
        Persona <span className="font-mono">{conflict.entityId}</span> diverged
        between the local replica and the server. Pick a side or merge fields
        manually.
      </p>
      <ParamComparator fields={PERSONA_FIELDS} conflict={conflict} />
    </div>
  );
}
