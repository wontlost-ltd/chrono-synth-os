# 0011 — `core_values` is tall (one row per value), tenant-scoped

**Status:** Accepted
**Date:** 2025-Q3 (back-filled 2026-05; corrected 2026-05-06 after
verifying actual schema)
**Scope:** `src/storage/migrations.ts` v001 + v007 + v009, kernel
value-graph commands

## Context

A persona's value graph (curiosity, autonomy, financial-security, …)
is a small list (10–40 typed weights) read on every cognitive cycle
and written on every drift tick. The schema choice was either:

1. **Tall**: one row per `(persona, value_id)` with `weight REAL`.
2. **Wide**: one row per persona with the value graph as
   `values_json TEXT`.

The kernel's dominant pattern is "load the whole graph", which on
the surface favors wide. But the tall layout has equal performance
with an indexed range scan and lets callers do per-value updates
without a JSON round-trip.

## Decision

`core_values` is **tall**, schema below. PK is `id` (per row);
tenant scoping is via the `tenant_id` column added in v007.

```sql
CREATE TABLE core_values (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
  updated_at INTEGER NOT NULL
);
-- v007: ALTER TABLE core_values ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
-- v009: ALTER TABLE core_values ADD COLUMN time_discount REAL NOT NULL DEFAULT 0.5;
-- v009: ALTER TABLE core_values ADD COLUMN emotion_amplifier REAL NOT NULL DEFAULT 1.0;
CREATE INDEX idx_core_values_tenant ON core_values(tenant_id);
```

The kernel reads "everything for a tenant" (single indexed scan);
writes are per-row UPDATE/INSERT statements rather than a full JSON
rewrite.

## Consequences

**Wins**

- Per-value updates are cheap. Drift tick updates the 1–3 values
  that changed, not the whole graph.
- The `weight CHECK (>= 0 AND <= 1)` constraint runs at write time;
  a JSON column would require app-level validation.
- Adding a new field that applies per-value (`time_discount`,
  `emotion_amplifier` in v009) is a single ALTER, no migration of
  embedded JSON.
- Indexes can be added per-column when an access pattern emerges
  (e.g., "find all values with weight > 0.8"); a JSON column would
  need full-text-index workarounds.

**Costs**

- Reading the full graph for one persona is N rows instead of one.
  N is small (≤40); SQLite does this in a single B-tree range
  scan, postgres in a single index seek + sequential scan over
  ~40 rows. Measurable but not meaningful.
- Multi-statement updates (changing 5 values at once) ride on the
  surrounding UoW transaction. The kernel guards atomicity at the
  transaction boundary, not the row.
- Cross-persona sharding eventually wants a `persona_id` column;
  current schema is tenant-scoped only. Adding `persona_id` is a
  v0XX migration; planned alongside the projection store work
  (P3 backlog).

## Alternatives considered

- **Wide row with `values_json`**: rejected — see Consequences.
  Atomic full-row rewrite was attractive but per-value drift hits
  it on every tick.
- **JSONB column on PostgreSQL only**: rejected — driver-specific
  code path; we run on both backends.

## Related

- `src/storage/migrations.ts` v001, v007 (tenant_id), v009 (tuning columns)
- `src/storage/migrations.ts` v011 (`evolution_diff_report` audit)
- [0014 — integration tests use createMemoryDatabase](0014-integration-tests-memory-database.md)
