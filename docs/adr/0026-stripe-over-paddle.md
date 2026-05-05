# 0026 — Stripe over Paddle for payments

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `src/billing/`, `src/server/routes/billing.ts`

## Context

Chrono Synth Cloud charges by subscription with metered overage
(LLM tokens / simulations / API calls). Two payment providers fit
the SaaS-with-metering shape:

- **Stripe** — payment processor; we are the merchant of record.
  Handle tax, VAT, sales tax compliance ourselves (Stripe Tax helps).
- **Paddle** — merchant of record; handles tax + VAT + sales tax
  worldwide. Higher fee but eliminates tax compliance burden.

The right answer depends on company stage. Early-stage with limited
finance/legal capacity → Paddle is appealing. Established team with
tax / legal in place → Stripe gives more control and lower fees.

## Decision

**Stripe.** Specifically:

- Stripe Subscriptions for recurring plans.
- Stripe Billing's metered billing for overage usage.
- Stripe Tax for automatic tax calculation.
- Stripe Customer Portal for self-serve plan changes & invoices.

Webhooks land at `/api/v1/billing/webhooks/stripe` — signature-verified,
idempotent ([ADR 0023](0023-webhook-shared-secret-not-signed.md)
notably does *not* apply here; Stripe webhooks are signed and we
verify them, because Stripe's threat model is far more critical).

## Consequences

**Wins**

- Lower per-transaction fees (~2.9% + 30¢ vs Paddle's 5% + 50¢) at
  the scale we project.
- Best-in-class developer ergonomics: typed SDK, clear docs, live
  test mode, deterministic webhooks.
- Stripe Tax handles the bulk of tax-jurisdiction compliance for
  ~50 countries; the team's CFO accepts the residual risk for the
  rest.
- Customer-facing UX (Customer Portal) is professional with no
  custom UI work.

**Costs**

- We are merchant of record. Sales tax / VAT registration is on
  us in jurisdictions where Stripe Tax doesn't auto-handle (Brazil,
  India). Tracked as ops debt.
- Chargebacks and disputes are our problem; Paddle would absorb
  them. We accept this — chargeback rate on B2B SaaS is ~0.05%.
- Multi-currency display is more work than Paddle's "set it and
  forget" model. We hand-build currency switching in the UI.

## Alternatives considered

- **Paddle**: rejected — see context. Re-evaluate if the company
  ever wants to spin out an independent business unit without
  bringing tax/legal capacity along.
- **Lemon Squeezy**: rejected — too young; some procurement teams
  don't recognize it.
- **Build directly on payment processors (Adyen, Braintree)**:
  rejected — would multiply integration work without buying
  meaningful flexibility at our scale.

## Related

- `src/billing/` (Stripe wiring + plan service)
- `docs/operations/stripe-setup.md`
- `src/server/routes/billing.ts` (webhook handler)
