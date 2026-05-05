# 0024 — Don't auto-restart on schema migration failure

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/storage/migrations.ts`, `src/main.ts`, K8s deployment

## Context

The runtime applies pending migrations on startup. If a migration
fails (CHECK violation, conflicting index name, NOT NULL on a
backfilled column with bad data), the natural Kubernetes pattern
is to crash and let the kubelet restart the pod. RestartPolicy
`Always` will dutifully retry forever.

That's exactly the wrong behaviour. A failing migration with auto-
restart causes:

1. Repeated half-applied transactions — each retry might leave the
   schema in a different intermediate state if the migration has
   multiple statements.
2. Crash-loop noise that drowns out the actual cause in logs.
3. False "service is up" signal once the readiness probe flips,
   if a different pod happens to find the migration already applied
   by another (still-failing) pod.
4. Operators reaching for "just delete the pod" before reading the
   error.

## Decision

**On migration failure, the process exits with code 78 (EX_CONFIG)
and refuses to retry.** The error is logged with the offending
migration version, the SQL statement that failed, and the underlying
error message. The process does not start the HTTP server.

The deployment uses `restartPolicy: OnFailure` for migration jobs
*only* if the migration is wrapped in a pre-install Job; the main
deployment has `restartPolicy: Always` but the migration check is
a startup-blocking step that exits cleanly. Kubernetes will restart
the pod, the migration will fail again, and Prometheus will alert
on the crash-loop within ~5 minutes.

Operators must manually:

1. Inspect the failing pod's logs.
2. Determine root cause (data, schema, or migration bug).
3. Either fix the migration in source and roll forward, or run
   the corrective SQL manually and bump `schema_migrations` past
   the failing version.

## Consequences

**Wins**

- Operators are explicitly involved when schema state diverges
  from source. No silent corruption.
- Crash-loop is *also* a signal — Prometheus' `kube_pod_container_status_restarts_total`
  alert catches it; we don't need a separate "migration failed"
  metric.
- The migration code is simple: try to apply, fail loud if it
  doesn't.

**Costs**

- A bad migration in production is service-down until a human
  intervenes. We accept this — the alternative (silent partial
  apply) is worse.
- Engineers run the full migration chain locally (and via
  integration tests in CI, [ADR 0014](0014-integration-tests-memory-database.md))
  to catch issues before deploy.

## Alternatives considered

- **Auto-rollback on failure**: rejected — the kernel doesn't
  ship `down` migrations (we're forward-only by policy). Adding
  rollback would double the migration test surface.
- **Best-effort: log and continue**: rejected — silent partial
  apply is the worst of all worlds.

## Related

- [0014 — integration tests with createMemoryDatabase](0014-integration-tests-memory-database.md)
- `src/storage/migrations.ts` (`applyAllMigrations`)
- `docs/operations/disaster-recovery-runbook.md` § migration failure
