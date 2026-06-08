/**
 * Shared components for resolution-panel renderers.
 *
 * Each entity type has its own panel that knows which `summaryParams`
 * fields are meaningful for it, but they all share a two-column
 * "local vs server" layout and a couple of trivial primitives below.
 * Keeping the primitives here means a layout tweak (spacing,
 * label colour) happens in one place.
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';

/** Format a summary-param value for display. The contract restricts
 *  these to string | number; we coerce nullish for safety in case a
 *  stray entry slips through future schema migrations. */
export function formatParam(value: string | number | null | undefined): string {
  if (value == null) return '—';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString() : '—';
  }
  return value;
}

/** Two-column "local | server" comparator. Highlights diverging values
 *  so the user can spot what actually conflicts without scanning every
 *  row. Equal values render with `text-text-secondary` (de-emphasised);
 *  diverging values render with `text-text-primary` and a subtle border.
 *
 *  Unknown fields: any key present in localSummaryParams or
 *  serverSummaryParams but NOT in `fields` is rendered after the
 *  curated rows with the raw key as its label. Without this fallback,
 *  a contract addition would silently hide from the UI — and conflict
 *  resolution can't afford silent omissions. */
export function ParamComparator({
  fields,
  conflict,
}: {
  fields: { id: string; label: string }[];
  conflict: ConflictInboxItemV1;
}) {
  const knownIds = new Set(fields.map((f) => f.id));
  const allKeys = new Set([
    ...Object.keys(conflict.localSummaryParams),
    ...Object.keys(conflict.serverSummaryParams),
  ]);
  const extras = Array.from(allKeys)
    .filter((k) => !knownIds.has(k))
    .sort()
    .map((k) => ({ id: k, label: k }));
  const rows = [...fields, ...extras];

  return (
    <dl className="grid gap-3 text-sm md:grid-cols-[max-content_1fr_1fr]">
      <div className="hidden md:contents text-xs font-semibold uppercase tracking-wider text-chrono-text-tertiary">
        <span />
        <span>Local</span>
        <span>Server</span>
      </div>
      {rows.map(({ id, label }) => {
        const local = conflict.localSummaryParams[id];
        const server = conflict.serverSummaryParams[id];
        const diverges = local !== server;
        return (
          <div key={id} className="md:contents">
            <dt className="font-medium text-chrono-text-secondary">{label}</dt>
            <dd
              className={
                diverges
                  ? 'rounded border border-chrono-accent/40 bg-chrono-accent/5 px-2 py-1 font-mono text-xs text-chrono-text-primary'
                  : 'px-2 py-1 font-mono text-xs text-chrono-text-tertiary'
              }
            >
              {formatParam(local)}
            </dd>
            <dd
              className={
                diverges
                  ? 'rounded border border-chrono-accent/40 bg-chrono-accent/5 px-2 py-1 font-mono text-xs text-chrono-text-primary'
                  : 'px-2 py-1 font-mono text-xs text-chrono-text-tertiary'
              }
            >
              {formatParam(server)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
