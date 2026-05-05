# 0028 — `audit_log` is per-tenant, not global

**Status:** Accepted
**Date:** 2025-Q3
**Scope:** `src/audit/audit-log-store.ts`, `src/storage/migrations.ts` v002

## Context

Audit logs record sensitive operations: who changed what, when, in
which tenant. The natural shape is one global `audit_log` table
keyed by tenant_id. The alternative is one schema-per-tenant or
one table-per-tenant with the table name encoding the boundary.

A global table is operationally simpler — one sweep job, one set
of indexes, one query path. But "audit_log" is the table most
likely to be the target of a customer's compliance audit, and the
question "show me everything I logged for tenant X" must return
exactly what was recorded for X with zero leakage.

## Decision

**One `audit_log` table; every row carries `tenant_id NOT NULL`;
every query is parameterized by `tenant_id`.** The application
layer never issues a bare `SELECT FROM audit_log`; it always uses
the `audit-log-store.ts` helpers, which require a tenant context.

Schema:

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,            -- 'request' | 'business'
  actor_id TEXT,
  action_type TEXT NOT NULL,
  target_type TEXT, target_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_tenant_created ON audit_log(tenant_id, created_at DESC);
```

Tenant deletion (offboarding) does a single `DELETE FROM audit_log
WHERE tenant_id = ?`. The KMS key for that tenant is dropped in
the same workflow ([ADR 0004](0004-field-level-encryption.md)
crypto-shred), so even backups become unreadable.

## Consequences

**Wins**

- One schema to migrate, one sweep job, one set of indexes.
- Cross-tenant queries are *intentionally* impossible from the
  application layer — the `audit-log-store` API rejects calls
  without a tenant context. Reviewers don't have to spot a
  missing WHERE clause; the type system enforces it.
- Tenant offboarding is one DELETE plus a KMS key delete.

**Costs**

- A bug in the tenant-context plumbing could leak across tenants
  (e.g., if a request without a tenantId somehow runs with `''`
  and another tenant happens to also use `''`). We defend with
  the `tenantId` plugin asserting non-empty in non-public paths,
  and the audit-log-store rejecting empty strings.
- VACUUM after large tenant deletes can be slow on Postgres. We
  schedule deletes off-hours and measure VACUUM duration as part
  of the offboarding runbook.

## Alternatives considered

- **Schema per tenant**: rejected — operationally horrendous at
  scale (1000s of schemas, migration coordination is a nightmare).
- **Table per tenant** (e.g., `audit_log_<tenantId>`): rejected
  — same migration problem, plus dynamic SQL generation makes
  the application code uglier.
- **Separate database per tenant**: rejected — billing and
  cross-tenant reporting (which we do, in aggregate) become
  multi-DB queries. Plus connection-pool blowup.

## Related

- [0004 — field-level encryption](0004-field-level-encryption.md)
- `src/audit/audit-log-store.ts`
- `src/storage/migrations.ts` v002 + v040 (extended audit log)
