# 0010 — Retention windows are env-tunable, not hardcoded

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/storage/retention.ts`, `src/server/config.ts`

## Context

Several tables grow unboundedly without retention policy:

- `tool_invocations` (~10 KB per row, hundreds per persona per day)
- `audit_log` (legally bound, but per-class retention varies)
- `webhook_log` (debug aid, useless after a week)
- `events_user_journey` (analytics)

Single-tenant SaaS, multi-tenant SaaS, on-prem, and the bundled
desktop edition each have different obligations:

| Edition         | tool_invocations | audit_log | webhook_log |
| --------------- | ---------------- | --------- | ----------- |
| Cloud (default) | 90 days          | 7 years   | 30 days     |
| Enterprise on-prem | configurable    | configurable | configurable |
| Desktop         | 30 days          | 1 year    | 7 days      |

Hardcoding any of these in source means a config change is a release.
Per-tenant config in the DB is overkill for what is, structurally, a
small set of duration values.

## Decision

**Retention windows are read from environment variables at startup**,
with documented defaults baked into `config.ts`. The migration / vacuum
job reads the live config — no rebuild needed to change retention.

```ts
const RETENTION = {
  toolInvocationsDays: env.int('CHRONO_RETENTION_TOOL_INVOCATIONS_DAYS', 90),
  auditLogYears: env.int('CHRONO_RETENTION_AUDIT_LOG_YEARS', 7),
  webhookLogDays: env.int('CHRONO_RETENTION_WEBHOOK_LOG_DAYS', 30),
  eventsUserJourneyDays: env.int('CHRONO_RETENTION_EVENTS_DAYS', 365),
};
```

A nightly job (`src/jobs/retention-cleanup.ts`) deletes rows older than
the window in batches of 10 000. Audit log deletion writes a meta-audit
row so the deletion itself is recorded.

Per-tenant overrides are *not* supported in this design. If a customer
needs different retention for one tenant, they get a separate
deployment.

## Consequences

**Wins**

- Operators tune retention without touching source.
- The same image ships to every edition; only env vars differ.
- Tests can use 1-second windows by setting the env var; no special
  test path in the cleanup logic.

**Costs**

- The cleanup job has to be defensive: a typo'd env var that sets
  retention to "0" would purge everything. We refuse to start if any
  retention value is below a hard floor (1 day for tool_invocations,
  90 days for audit_log).
- Customers who need *per-tenant* retention have to run a separate
  process. We accept this — multi-tenancy at the retention layer is a
  big design and we don't yet have a customer asking for it.

## Alternatives considered

- **Hardcoded defaults, change via release:** rejected — every
  retention change becomes a release, undue ops drag.
- **Per-tenant config table:** rejected for now — adds a config-fetch
  to every cleanup pass, and we have no validated demand.
- **External policy engine (OPA):** rejected — disproportionate
  machinery for setting four duration values.

## Related

- `src/storage/retention.ts`
- `src/jobs/retention-cleanup.ts`
- [ADR 0028 — audit_log per-tenant not global](#) (planned)
