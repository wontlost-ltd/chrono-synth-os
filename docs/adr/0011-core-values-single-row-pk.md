# 0011 — `core_values` uses a single-row PK per persona

**Status:** Accepted
**Date:** 2025-Q3 (back-filled 2026-05)
**Scope:** `src/storage/migrations.ts` v009, kernel value-graph commands

## Context

A persona's value graph (10–40 typed weights — curiosity, autonomy,
financial-security, …) lives in `core_values`. Two table shapes were
considered:

1. **Wide row** — one row per `persona_id` with each value as a
   typed JSON column or N nullable typed columns.
2. **Tall table** — one row per `(persona_id, value_id)` with a
   `weight` column.

The kernel reads the full value graph on every cognitive cycle and
writes a partial update on every drift tick. With ~10 personas × 1
read/sec, the dominant access pattern is "get all values for one
persona", and a wide row delivers it in one PK lookup.

## Decision

`core_values` is **wide**: one row per `persona_id`, with the value
graph stored as a single `values_json TEXT NOT NULL` column. The PK
is `persona_id` (single column).

```sql
CREATE TABLE core_values (
  persona_id TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  values_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Updates rewrite the full row; the kernel computes the delta against
the previous JSON and stores both the new payload and a separate
`evolution_diff_report` audit row (v011).

## Consequences

**Wins**

- One read = full value graph. No ORM-level joins.
- Schema migrations don't have to ALTER COLUMN per value type — new
  values land inside the JSON without a DDL change.
- Atomic rewrite: a single `UPDATE` either lands fully or rolls
  back; we can't end up with a partial value graph mid-tick.
- Cross-driver portable (SQLite + PostgreSQL both treat TEXT JSON
  uniformly; we don't depend on JSONB).

**Costs**

- Per-value queries are scans (`json_extract` or app-level filter);
  unacceptable if we ever need cross-persona "show me everyone whose
  curiosity > 0.8". We solve those via the projection store
  ([ADR 0054 — projection store](#) planned), not by changing this
  table.
- Concurrent updates serialize on the row. Acceptable — value
  updates are domain-serial within a persona by design (one
  cognitive tick at a time).

## Alternatives considered

- **Tall table**: rejected — the dominant read pattern would have
  to do `SELECT … WHERE persona_id = ?` and return 30+ rows, which
  the kernel then has to assemble. Slower and more code.
- **JSONB column on PostgreSQL only**: rejected — would force a
  driver-specific code path. JSON-as-TEXT works on both backends.

## Related

- [0010 — Retention env-tunable](0010-retention-env-tunable.md)
- `src/storage/migrations.ts` v009 (`core_values`)
- `src/storage/migrations.ts` v011 (`evolution_diff_report`)
