/**
 * Memory conflict — typical fields:
 *   title, content (truncated), salience, accessedAt, decayRate
 *
 * Memory content can be long; the contract truncates it server-side
 * (summary-template only renders the first ~80 chars) — we just render
 * what the contract provides without further truncation.
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ParamComparator } from './shared';

const MEMORY_FIELDS = [
  { id: 'title', label: 'Title' },
  { id: 'contentPreview', label: 'Content preview' },
  { id: 'salience', label: 'Salience' },
  { id: 'accessedAt', label: 'Last accessed' },
  { id: 'decayRate', label: 'Decay rate' },
];

export function MemoryConflictPanel({ conflict }: { conflict: ConflictInboxItemV1 }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-chrono-text-secondary">
        Memory <span className="font-mono">{conflict.entityId}</span> has
        diverging values. Salience + decay-rate differences usually mean a
        long offline session — picking the server side is the safe default.
      </p>
      <ParamComparator fields={MEMORY_FIELDS} conflict={conflict} />
    </div>
  );
}
