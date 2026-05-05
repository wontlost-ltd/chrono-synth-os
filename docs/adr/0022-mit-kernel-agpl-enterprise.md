# 0022 — MIT for the kernel, AGPL for enterprise modules

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** repository licensing

## Context

The codebase has two distinct audiences:

1. **The kernel and adapters** (`@chrono/kernel`, `@chrono/contracts`,
   `@chrono/data-plane`, `@chrono/sync-engine`, the adapters, the
   testkit). Anyone embedding our persona engine in their own product
   needs maximum freedom; restrictive licenses kill adoption.
2. **The runtime service** (`chrono-synth-os` server, the multi-tenant
   admin surfaces, billing, SSO). Hosted SaaS competitors who fork
   this and run it commercially without contributing back are an
   existential risk.

A single license can't serve both. The two real options were dual-MIT
(give it all away) or dual-MIT/AGPL.

## Decision

**Dual-license:**

- `packages/kernel`, `packages/contracts`, `packages/data-plane`,
  `packages/sync-engine`, `packages/design-tokens`, `packages/adapter-*`,
  `packages/kernel-testkit`: **MIT**.
- The repo root + `src/**` (server code, billing, SSO, admin surface,
  SLO addons): **AGPL-3.0-or-later**.

Each `packages/*` ships its own `LICENSE` file. The root `LICENSE` is
AGPL.

## Consequences

**Wins**

- Embedding the kernel in a third-party app is frictionless. They
  pull `@chrono/kernel` and ship; no compliance review needed.
- A SaaS competitor running our full service has to publish their
  modifications (AGPL-3.0 §13 — network distribution triggers source
  release). Strong moat against lift-and-rehost.
- Clear separation: a contributor adding kernel features writes code
  that can be reused freely; a contributor touching billing or SSO is
  contributing to AGPL'd code.

**Costs**

- Some enterprise customers refuse AGPL anywhere in their stack. For
  them, we offer a **commercial license** for the AGPL parts
  (negotiated per deal). The kernel itself stays MIT — they can build
  on top without commercial licensing.
- Maintenance cost: every PR has to land in the right tree, and
  reviewers check the license header. Mitigated by `npm run check:
  licenses` in CI (planned, [follow-up]).

## Alternatives considered

- **Pure MIT everywhere**: rejected — competitors take our work and
  rehost without contributing back. We've seen this happen to peer
  projects.
- **Pure AGPL everywhere**: rejected — kills kernel embedding, which
  is a strategic distribution channel.
- **BSL (Business Source License)**: rejected — non-OSI; some
  customer procurement teams treat it as proprietary regardless of
  the eventual conversion clause.
- **Elastic License v2**: rejected — same procurement issue, plus
  it's young and the case law is thin.

## Related

- `LICENSE` (AGPL-3.0)
- `packages/*/LICENSE` (MIT per package)
- `.github/workflows/security.yml` § license-check (allowlist enforces
  the dependency-license boundary, separate from our own licensing)
