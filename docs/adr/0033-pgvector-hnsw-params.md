# 0033 — pgvector HNSW: m=16, ef_construction=64

**Status:** Accepted
**Date:** 2026-05 (pgvector stages 1-7)
**Scope:** `src/storage/postgres-migrations.ts` v071, `chrono-synth-deploy/k8s/base/postgres/`

## Context

In May 2026 we replaced the JS in-process IVF index for memory
embeddings with a real pgvector HNSW index inside Postgres 17.
Migration v071 adds the `embedding vector(N)` column and creates the
HNSW index for cosine similarity:

```sql
CREATE INDEX memory_embeddings_hnsw_idx
  ON memory_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

HNSW takes two build-time parameters. Both have well-understood
trade-offs but no objectively correct value — they encode an explicit
recall/latency/memory triangle.

- **m** = max neighbours per node in the lower graph layers. Larger m =
  higher recall + bigger index in memory + slower build. pgvector
  upstream default is 16; ranges 8–48 are common in literature.
- **ef_construction** = candidate set size during index build. Larger =
  higher final recall + slower build (linear-ish in `ef_construction`).
  pgvector upstream default is 64; production values 64–256.

Query-time `ef_search` is set per-session, not at build, so it doesn't
appear in this migration.

We're sizing for:
- 1536-dim embeddings (OpenAI text-embedding-3-small)
- expected per-tenant scale: 10k–100k memory rows mid-term, 1M long
- query target: P99 < 5ms cluster-side
- read:write ≈ 100:1 (memories are read on every retrieval, written
  episodically)

## Decision

**`m = 16`, `ef_construction = 64`** — pgvector's upstream defaults.

We deliberately did not bump these on launch. Reasons:

1. Index build time at `ef_construction = 256` on a 1M-row table is
   minutes, not seconds. v071 runs as a regular migration; tenants
   coming online via backfill (`scripts/pgvector-backfill.ts`) would
   block the deploy if build was slow.
2. We have no production recall measurement yet to justify a bigger
   index. Tuning beyond defaults without measurement is cargo-culting.
3. The `embedding_index_factory` abstraction (ADR pending) lets us
   tune per-tenant later — a "noisy neighbour" tenant on the upper
   end of 100k can flip to a custom index without a global migration.

## Consequences

**Wins**

- v071 completes in seconds on tables up to ~100k rows; backfill
  workers don't time out.
- Memory footprint per index: roughly `m × dim × 4 bytes × N`. At
  m=16, dim=1536, N=1M, that's ~100 MB per tenant. Comfortably fits
  the prod RDS instance class.
- Recall at default settings is ≥0.95 vs. brute-force on synthetic
  benchmarks we ran in stage 4 (see `scripts/pgvector-drift-verify.ts`).

**Costs**

- We're explicitly leaving recall on the table. m=24 / ef_c=128 would
  push recall closer to 0.99 at ~2× build time and ~50% larger index.
  If a customer reports "missing relevant memories", this is the first
  knob to turn.
- HNSW indexes are not crash-recoverable in pgvector — they rebuild
  on PostgreSQL restart of the index page. Not actually true for HNSW
  in pg_vector ≥ 0.5; we're on 0.7, so this is fine. Earlier docs
  warned about this; we verified.

## Alternatives considered

- **m = 24, ef_construction = 200** (upstream "high recall" recipe):
  rejected for launch. Saves no engineering complexity; defers the
  tunable to "after we measure". When we have real recall complaints
  with reproduction data, we'll lift m first because m affects every
  query, while ef_construction is a one-time cost.

- **IVF flat index instead of HNSW:** rejected. IVF has lower memory
  but higher P99 tail latency under skewed query distributions.
  pgvector docs recommend HNSW for any workload with hot routes.

- **Per-(tenant, model) HNSW partitioning:** rejected for v0.71. The
  partial-index path (one HNSW per tenant) makes admin DDL much harder
  and prevents cross-tenant similarity queries (which we don't ship,
  but which contract tests will eventually want). Migration v071's
  helper indexes already provide WHERE-clause optimization; we
  revisit partitioning at the 1M-row mark.

## How to revisit

When we start serving customers reporting "missed retrieval", the
order of escalation is:

1. **Increase `ef_search`** (per-session, no migration): try 100, 200.
   Most recall complaints disappear here.
2. **Bump `m` to 24 or 32**: requires REINDEX. Coordinate maintenance
   window; document in `docs/operations/pgvector-rollout.md`.
3. **Bump `ef_construction` to 128 or 200**: same REINDEX cost.
4. Only after the above: switch to a per-tenant index strategy.

Track recall metric in production via `chrono_embedding_query_recall`
(planned; not yet exported).

## Related

- [ADR-0001 — Kernel zero runtime deps](0001-kernel-zero-runtime-deps.md) —
  the embedding-index port abstraction lives in the kernel; the choice
  of pgvector lives in the adapter
- `src/storage/postgres-migrations.ts` v071 — concrete SQL with comments
- `docs/operations/pgvector-rollout.md` — staged rollout runbook
- `scripts/pgvector-backfill.ts` — tenant backfill tool
- `scripts/pgvector-drift-verify.ts` — recall verification tool used
  to prove default-param recall ≥ 0.95
