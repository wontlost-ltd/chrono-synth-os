/**
 * Conflict list — left pane in the conflict-inbox layout.
 *
 * Groups conflicts by entityType so the user can triage one class at
 * a time. Within each group, blocking conflicts sort first; warnings
 * follow. Each row is keyboard-navigable (the parent renders these as
 * native `<button>`s so Tab order matches DOM order).
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';

type EntityType = ConflictInboxItemV1['entityType'];

const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  persona: 'Personas',
  memory: 'Memories',
  task: 'Tasks',
  device: 'Devices',
  policy: 'Policies',
};

/** Stable display order for entity groups — higher-stakes classes
 *  (policy) surface first so the user encounters them at the top of
 *  the inbox. */
const ENTITY_ORDER: EntityType[] = ['policy', 'persona', 'task', 'memory', 'device'];

function sortConflicts(a: ConflictInboxItemV1, b: ConflictInboxItemV1): number {
  /* blocking before warning */
  if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1;
  /* newer first within the same severity */
  return b.detectedAt.localeCompare(a.detectedAt);
}

export interface ConflictListProps {
  conflicts: ConflictInboxItemV1[];
  selectedConflictId: string | null;
  onSelect: (conflict: ConflictInboxItemV1) => void;
}

export function ConflictList({ conflicts, selectedConflictId, onSelect }: ConflictListProps) {
  if (conflicts.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-chrono-text-tertiary">
        No conflicts.
      </p>
    );
  }

  /* Group by entityType. */
  const groups = new Map<EntityType, ConflictInboxItemV1[]>();
  for (const conflict of conflicts) {
    const arr = groups.get(conflict.entityType) ?? [];
    arr.push(conflict);
    groups.set(conflict.entityType, arr);
  }
  for (const arr of groups.values()) arr.sort(sortConflicts);

  return (
    <nav aria-label="Conflict inbox">
      <ul className="space-y-4">
        {ENTITY_ORDER.filter((type) => groups.has(type)).map((type) => {
          const items = groups.get(type)!;
          return (
            <li key={type}>
              <h3 className="px-3 text-xs font-semibold uppercase tracking-wider text-chrono-text-tertiary">
                {ENTITY_TYPE_LABELS[type]}{' '}
                <span className="text-chrono-text-tertiary/70">({items.length})</span>
              </h3>
              <ul className="mt-1 space-y-0.5">
                {items.map((conflict) => {
                  const selected = conflict.conflictId === selectedConflictId;
                  return (
                    <li key={conflict.conflictId}>
                      <button
                        type="button"
                        onClick={() => onSelect(conflict)}
                        aria-current={selected ? 'true' : undefined}
                        className={`flex w-full items-start gap-2 rounded px-3 py-2 text-left text-xs transition-colors ${
                          selected
                            ? 'bg-chrono-accent/15 text-chrono-text-primary'
                            : 'text-chrono-text-secondary hover:bg-chrono-elevated'
                        }`}
                      >
                        <span
                          className={`mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                            conflict.severity === 'blocking' ? 'bg-error' : 'bg-chrono-accent'
                          }`}
                          aria-label={conflict.severity}
                        />
                        <span className="flex-1 overflow-hidden">
                          <span className="block truncate font-mono text-[11px] text-chrono-text-tertiary">
                            {conflict.entityId}
                          </span>
                          <span className="block text-[10px] text-chrono-text-tertiary/80">
                            {new Date(conflict.detectedAt).toLocaleString()}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
