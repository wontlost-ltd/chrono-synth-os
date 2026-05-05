# 0023 — `safety.alerts.webhookSecret` is a shared secret, not a signed payload

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/safety/webhook-emitter.ts`, drift-alert webhooks

## Context

When a drift-alert webhook fires ([ADR 0009](0009-drift-webhook-best-effort.md)),
the receiving customer needs a way to verify the request actually
came from us — not from anyone who guessed the URL. Two patterns:

1. **Shared secret** — both sides know a value; we send it as a
   header (e.g., `X-Chrono-Webhook-Secret: ...`); the receiver
   compares.
2. **Signed payload** — we sign the body with a private key; the
   receiver verifies with our public key (HMAC with shared secret,
   or asymmetric with key rotation).

Option 2 is what Stripe, GitHub, and most security-conscious
services use. We deliberately did not pick it.

## Decision

**Shared secret in a request header.** Default header is
`X-Chrono-Webhook-Secret`; the value comes from
`config.safety.alerts.webhookSecret`. The receiver does
constant-time compare. No signing, no nonce, no timestamp.

```http
POST /your/webhook HTTP/1.1
X-Chrono-Webhook-Secret: <shared-secret>
Content-Type: application/json
Content-Length: 412

{ "event": "drift.warning", ... }
```

Customers configure the secret per-tenant in admin config; the value
is encrypted at rest ([ADR 0004](0004-field-level-encryption.md)).

## Consequences

**Wins**

- Implementation is ~10 lines on each side. Customers integrate
  in an hour, not a day.
- No timing-attack surface for signature verification (no signing
  algorithm exposed).
- Rotation is simple: pick a new secret, update the config, done.
  No public-key-distribution dance.
- The threat model — "untrusted third party guesses the URL and
  sends fake alerts" — is fully addressed by a shared secret. We
  don't promise non-repudiation.

**Costs**

- A receiver who logs the secret somewhere (env-var leak, log
  scrubbing miss) is compromised. Same risk as basic auth or any
  shared-secret system. We document the rotation procedure
  clearly in `docs/operations/security-ci-runbook.md`.
- Replay attacks within the secret's validity window are possible.
  Acceptable: the alerts are informational; the audit log is the
  source of truth ([ADR 0009](0009-drift-webhook-best-effort.md)).

## Alternatives considered

- **HMAC-SHA256 over body**: rejected — moves complexity to the
  customer side without buying real safety against our threat model.
- **Asymmetric signing (Ed25519)**: rejected — even more complex;
  customers would need a key-rotation runbook we'd have to write.
- **mTLS**: rejected — operational overhead is enormous for a
  fire-and-forget alert path; customers without mTLS infra would
  just turn off webhooks.

## Related

- [0009 — drift webhook best-effort](0009-drift-webhook-best-effort.md)
- [0004 — field-level encryption](0004-field-level-encryption.md)
- `docs/operations/security-ci-runbook.md` § webhook secret rotation
