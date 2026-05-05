# 0009 — Drift-alert webhook is best-effort, not transactional outbox

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/safety/drift-monitor.ts`, `src/safety/webhook-emitter.ts`

## Context

When the persona-drift monitor detects a value-weight delta above
threshold, it (1) writes an audit row, and (2) calls a customer-supplied
webhook. The textbook answer for "do A and B atomically with the
outside world" is the **transactional outbox pattern**: write a row to
an `outbox` table inside the same transaction as the audit, then have a
separate worker scrape and dispatch.

Implementing outbox is real engineering — a worker, retry/backoff
state, dead-letter handling, idempotency keys, ordering guarantees. For
drift alerts specifically, none of this complexity earns its keep:

- The alert is informational. No money moves, no email goes out the
  receiving customer can't undo, no third party is mutated.
- The audit row in the DB is the *real* record. The webhook is a
  notification layer; if it's lost the audit still tells the truth.
- Customers run their own retry logic anyway — they pull the latest
  drift report on the schedule they want.

## Decision

**Drift-alert webhooks are fire-and-forget after the audit transaction
commits.** Sequence:

1. Inside the drift transaction: write `audit_log` row.
2. Commit.
3. Asynchronously call the customer webhook with a 2 s timeout, 3
   retries, exponential backoff. Log success/failure to `webhook_log`
   for observability, but never block on it and never roll back the
   audit if it fails.
4. If all retries fail, mark the `webhook_log` row as `failed`. The
   admin UI surfaces failed webhooks; no auto-retry beyond the initial
   3.

Customers who need stronger guarantees pull `/api/v1/admin/safety/drift-report`
on their own schedule.

## Consequences

**Wins**

- ~150 LOC in one file vs ~600 LOC across worker, schema, retry policy.
- No new infra surface to monitor (no extra worker, no extra queue).
- The audit row remains the source of truth; webhook is a hint.
- Test surface is tiny: mock the webhook target, assert calls.

**Costs**

- A sufficiently flaky network can lose a webhook even though the audit
  exists. Customers learn this once; the runbook explains the pull
  alternative.
- We can't promise "every audit produces exactly one webhook
  delivery". We *can* promise "every audit is queryable via the API".

## Alternatives considered

- **Full transactional outbox with worker:** rejected — see context. We
  may revisit if a future feature *does* require exactly-once external
  side effects (ADR will supersede this one).
- **Inline webhook call inside the transaction:** rejected — a slow
  webhook target would block the drift detector and risk timeouts on
  the underlying DB transaction.

## Related

- [0023 — webhook shared-secret, not signed payloads](#) (planned)
- `src/safety/drift-monitor.ts`
