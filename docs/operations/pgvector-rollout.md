# pgvector Rollout Runbook

This runbook captures the steps to ramp the embedding index from the
in-memory + JSON path to Postgres + pgvector across staging and prod.

The plan it operationalizes: `.claude/plan/pgvector-integration-2026.md`.

## State of play (2026-05-08)

| Stage | What it does | Status |
|---|---|---|
| 1 | Kernel query types (`embCmdUpsertPg`, `embQueryNearestPg`) | ✅ Shipped (`packages/kernel/src/domain/intelligence/embedding-pg-queries.ts`) |
| 2 | PG migration v071: add `vector(1536)` column + HNSW + dims trigger | ✅ Shipped (`src/storage/postgres-migrations.ts`) |
| 3 | `EmbeddingIndex` interface, `InMemoryEmbeddingIndex` + `PgvectorEmbeddingIndex`, factory | ✅ Shipped |
| 4 | Dual-write inside the executor + `pgvector-reconcile.ts` backfill/verify | ✅ Shipped (`scripts/pgvector-reconcile.ts`) |
| 5 | Per-tenant allowlist (`vectorExtensionTenants`) | ✅ Shipped |
| 6 | Helm chart values flip `useVectorExtension` per env (staging on, prod off) | ✅ Shipped (`chrono-synth-deploy/helm/chrono-synth/values-{staging,prod}.yaml`) |
| 7 | Migration v072 dropping `embedding_json` + IVF legacy tables | 🟡 Code shipped, NOT in `PG_MIGRATIONS` array — manually opt-in |

## Production rollout sequence

### Step A — confirm staging is clean

Prerequisites:

1. Helm staging deploy has `CHRONO_INTELLIGENCE_USE_VECTOR_EXT=true`
   (already in `values-staging.yaml`).
2. v071 has applied (`SELECT MAX(version) FROM schema_migrations`
   must be `>= 'v071'`).
3. Backfill of legacy rows has finished:

   ```bash
   PG_URL=postgres://... node dist/scripts/pgvector-reconcile.js \
     --mode=backfill --batch=500
   ```

4. Reconcile drift check is on a daily cron in staging:

   ```bash
   PG_URL=postgres://... node dist/scripts/pgvector-reconcile.js \
     --mode=verify
   ```

   Exit code 0 every day for ≥7 consecutive days.

If any of (1)–(4) fails, do NOT proceed. Investigate first.

### Step B — canary one prod tenant

Pick a small, known-stable tenant. Edit `values-prod.yaml`:

```yaml
backend:
  env:
    CHRONO_INTELLIGENCE_USE_VECTOR_EXT: "false"
    CHRONO_INTELLIGENCE_VECTOR_EXT_TENANTS: "tenant-canary-id"
```

`helm upgrade`. The factory routes `tenant-canary-id` to
`PgvectorEmbeddingIndex`; everyone else stays on `InMemoryEmbeddingIndex`.

Watch for ≥3 days:

- Conversation latency for that tenant (`p50_search_ms` metric)
- Error rate
- DB CPU / connection count
- Drift verifier output for that tenant's rows

### Step C — ramp to 10% / 50% / 100%

Append more tenants to `CHRONO_INTELLIGENCE_VECTOR_EXT_TENANTS` and
`helm upgrade`. Wait ≥1 day between ramp steps.

When you're ready for the global flip:

```yaml
backend:
  env:
    CHRONO_INTELLIGENCE_USE_VECTOR_EXT: "true"
    # Allowlist becomes redundant once the global flag is on; keep
    # it for documentation but it has no effect.
    CHRONO_INTELLIGENCE_VECTOR_EXT_TENANTS: ""
```

### Step D — observe ≥7 days at 100%

While `useVectorExtension=true` globally:

- Reconcile cron exits 0 every day.
- No latency regressions.
- No new error categories tied to embedding paths.

If anything looks off, drop the global flag back to `false` — the
in-memory path is still wired up and will resume on the next pod
restart since `embedding_json` is still being dual-written.

### Step E — execute v072 (drop legacy)

In `src/storage/postgres-migrations.ts`, the migration
`v072_drop_embedding_json_legacy` is defined but is not included in
the `PG_MIGRATIONS` array. To execute it:

1. Add `v072_drop_embedding_json_legacy` to `PG_MIGRATIONS` in commit
   order (after `v071_pgvector_embeddings`).
2. Push. The next backend startup runs v072 in transactional mode:
   - `ALTER TABLE memory_embeddings DROP COLUMN IF EXISTS embedding_json`
   - `DROP TABLE IF EXISTS ivf_centroids`
   - `DROP TABLE IF EXISTS ivf_meta`
3. Verify: `\d memory_embeddings` no longer shows `embedding_json`;
   `\dt ivf_*` returns no rows.

This is irreversible without a restore. Make sure step D was clean.

### Rollback contract

| Where | How to revert |
|---|---|
| Step B/C tenant canary | Remove tenant id from `VECTOR_EXT_TENANTS`, helm upgrade |
| Step C global flag | Set `USE_VECTOR_EXT=false`, helm upgrade — InMemory resumes |
| Step E migration | The plan considers this point-of-no-return. Recovery is restore-from-backup |

## Why v072 isn't in `PG_MIGRATIONS` yet

Migrations execute on every backend startup. Putting v072 in the
array would mean any deployment that hadn't yet completed steps A–D
would silently drop `embedding_json` and break the rollback path —
potentially across the whole org if a stale CI build hit prod.

The "manual opt-in" gate forces an explicit code change at trigger
time, which gets a PR review and a clear commit hash to point at if
something goes wrong.
