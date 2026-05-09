# 0034 — Subscription gate fails closed (402), no silent degradation

**Status:** Accepted
**Date:** 2026-Q2 (P1-D Stripe billing)
**Scope:** `src/billing/subscription-gate-service.ts`, `src/server/routes/conversation.ts` (and other gated routes)

## Context

Phase 1-D shipped real Stripe subscriptions: `active`, `trialing`,
`past_due`, `canceled` lifecycle. Billing routes (most importantly
`POST /conversations/messages`, `POST /knowledge-sources/bulk`) now
have a subscription gate that runs before the work happens.

When billing is unhappy, there are two competing failure-mode
philosophies:

- **Fail open / silent degradation:** still let the request through,
  log a metric, recover billing later. Reduces user-visible impact;
  the system "feels reliable" even when the billing relationship is
  broken.
- **Fail closed:** reject with `402 Payment Required` (or `403`),
  surface an actionable error message + `upgradeUrl`. User sees an
  immediate "you can't do this until X" prompt.

Failing open is tempting — Stripe webhooks can lag, and a 30-second
billing-state-out-of-sync window shouldn't block a paying user. But
silent degradation has a long history of biting:

- `past_due` users discover months later that they were "still using
  the product" without realising they hadn't paid; refund / chargeback
  becomes a 3-way headache.
- The decision to "let them through" is implicit in code; if a future
  refactor changes timeout behaviour or webhook retry policy, the
  silent path expands.
- It's incompatible with PCI / SaaS controls auditors look for. "Why
  did you let this user use $X of GPU when they were past due?" is a
  question we don't want to answer.

## Decision

**The subscription gate fails closed.** When the user is not in good
standing, the response is `402 Payment Required` with a structured
body containing `reason`, `upgradeUrl`, and (for `past_due_within_grace`)
the grace-period end timestamp.

Specifically (from `subscription-gate-service.ts`):

| State                    | Gate result | HTTP status |
| ------------------------ | ----------- | ----------- |
| `active`                 | allow       | (route runs) |
| `trialing`               | allow       | (route runs) |
| `past_due`, in grace     | allow + audit-flag | (route runs) |
| `past_due`, grace expired | deny       | **402** |
| `canceled` + within free quota | allow | (route runs) |
| `canceled` + over free quota | deny    | **402** |
| no subscription row     | treat as free, gate by quota | 402 if over |

The body always includes:

```json
{
  "error": "payment_required",
  "reason": "<machine code>",
  "upgradeUrl": "https://chrono.example.com/billing/checkout",
  "details": "..."
}
```

## Consequences

**Wins**

- One invariant the codebase enforces: **a request that runs the
  expensive work always corresponds to a paying / trialing tenant**.
  This is testable, auditable, and doesn't drift over time.
- Frontend has a single error path: 402 → render upgrade CTA. No
  "soft warning banner" UI to design and maintain.
- "Why is this tenant using GPU minutes" is answerable from
  `subscriptions.status` alone; no shadow allow-list to reason about.
- Compatible with future SOC2 / PCI controls: the audit answer for
  "did billing-failed users access paid features" is "no, the gate
  refused".

**Costs**

- Brief (sub-minute) Stripe webhook delay can cause a paying user to
  see a 402 if their card just succeeded but the webhook hasn't
  arrived. Mitigation: the `past_due_within_grace` allow path and
  the `SettlementReconciliationWorker` close the loop.
- Users in `past_due` with grace remaining still see audit-flagged
  warnings in their billing UI. We chose to surface the risk early
  rather than hide it; the alternative is an upset user discovering
  later they were "in the danger zone for two weeks".

## Alternatives considered

- **Soft fail (run the work, log metric, alert):** rejected, see
  Context. Operational cost of "silently degraded" mode is permanent
  cognitive load.
- **Fail open with user-visible toast:** rejected. UI noise that
  trains users to ignore important warnings.
- **Different status code (403 / 422):** rejected. RFC 7231 reserves
  402 for exactly this case; HTTP libraries treat 402 as a known
  payment-required state.

## How to enforce going forward

- New gated endpoints take a `SubscriptionGateService` parameter.
  Adding a route that does paid work without invoking the gate fails
  the contract test in `src/test/integration/subscription-gate.test.ts`
  (which sweeps known paid routes for the pre-handler).
- Webhook handler must always be the source of truth for state
  transitions; reconciliation worker is a safety net, never the
  primary path.
- Any "let this user through despite gate" override must go through
  `audit_log` with operator identity. There is no programmatic
  bypass.

## Related

- [ADR-0010 — Retention windows are env-tunable](0010-retention-env-tunable.md)
- `src/billing/subscription-gate-service.ts` — concrete logic
- `src/billing/settlement-reconciliation-service.ts` — webhook lag safety net
- `.claude/plan/done/p1-d-stripe-real-billing.md` — feature plan
