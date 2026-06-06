# Architecture Decision Records

This directory captures the architectural decisions that shape Chrono Synth OS.
Each record is written in [MADR](https://adr.github.io/madr/) lite form: one
problem, the chosen option, why we chose it, and what we knowingly gave up.

## How to read these

Read the index for orientation, then jump to whichever record is closest to
the area you're touching. The records are not strictly chronological — they
were back-filled to document decisions that were already in production.

## How to add a new one

1. Pick the next free number (`0031`, `0032`, ...).
2. Copy `0001-kernel-zero-runtime-deps.md` as a template.
3. Submit it in the same PR as the change it documents. ADRs that lag the
   code by months are worse than no ADR at all.

A decision worth an ADR is one that:

- A future engineer will be surprised by ("why didn't we just …?")
- Is hard or expensive to reverse later
- Trades off two reasonable alternatives — record what we sacrificed

A decision **not** worth an ADR is one that follows a well-known pattern
without controversy ("we use TypeScript", "we lint with ESLint"). Those
belong in `CONTRIBUTING.md` or `README.md`.

## Index

| #  | Title                                                              | Status   |
| -- | ------------------------------------------------------------------ | -------- |
| 01 | [Kernel has zero runtime dependencies](0001-kernel-zero-runtime-deps.md) | Accepted |
| 02 | [SyncWriteUnitOfWork is sync-only](0002-sync-write-unit-of-work.md)      | Accepted |
| 03 | [JSON kind constants over typed factories](0003-json-kind-constants.md)  | Accepted |
| 04 | [Field-level encryption with envelope keys](0004-field-level-encryption.md) | Accepted |
| 05 | [MCP protocol for the agent tool layer](0005-mcp-tool-protocol.md)       | Accepted |
| 06 | [Portability pack v1 (JSON-LD)](0006-portability-pack-v1.md)             | Accepted |
| 07 | [Version-aware commitImport](0007-version-aware-import.md)               | Accepted |
| 08 | [`IDatabase` implements `SyncWriteUnitOfWork` directly](0008-idatabase-implements-uow.md) | Accepted |
| 09 | [Drift-alert webhook is best-effort, not outbox](0009-drift-webhook-best-effort.md)       | Accepted |
| 10 | [Retention windows are env-tunable, not hardcoded](0010-retention-env-tunable.md)         | Accepted |
| 11 | [`core_values` is tall (one row per value), tenant-scoped](0011-core-values-tall-schema.md) | Accepted |
| 12 | [`agency_authorizations` is separate from `tool_permissions`](0012-agency-vs-tool-permission.md) | Accepted |
| 13 | [Confirmation tokens don't persist arguments](0013-confirmation-tokens-no-args.md)         | Accepted |
| 14 | [Integration tests use `createMemoryDatabase()`](0014-integration-tests-memory-database.md) | Accepted |
| 15 | [Kernel commands return `{ rowsAffected }`, not `T`](0015-kernel-commands-rows-affected.md) | Accepted |
| 16 | [npm workspaces monorepo over polyrepo](0016-monorepo-workspaces.md)                       | Accepted |
| 17 | [No Redux / Zustand / Pinia in `@chrono/adapter-web`](0017-no-redux-zustand-in-adapter-web.md) | Accepted |
| 18 | [Tauri over Electron for the desktop app](0018-tauri-over-electron.md)                     | Accepted |
| 19 | [React Native uses structural driver aliases](0019-rn-structural-driver-aliases.md)        | Accepted |
| 20 | [ArgoCD over Flux for GitOps](0020-argocd-over-flux.md)                                    | Accepted |
| 21 | [kustomize over Helm for K8s manifests](0021-kustomize-over-helm.md)                       | Accepted |
| 22 | [MIT for the kernel, AGPL for enterprise modules](0022-mit-kernel-agpl-enterprise.md)      | Accepted |
| 23 | [`safety.alerts.webhookSecret` is shared secret, not signed payload](0023-webhook-shared-secret-not-signed.md) | Accepted |
| 24 | [Don't auto-restart on schema migration failure](0024-no-auto-restart-on-migration-fail.md) | Accepted |
| 25 | [JSON over YAML for runtime config](0025-json-config-over-yaml.md)                         | Accepted |
| 26 | [Stripe over Paddle for payments](0026-stripe-over-paddle.md)                              | Accepted |
| 27 | [We don't ship a CLI](0027-no-cli.md)                                                      | Accepted |
| 28 | [`audit_log` is per-tenant, not global](0028-audit-log-per-tenant.md)                      | Accepted |
| 29 | [All timestamps are epoch milliseconds (`number`), not strings](0029-epoch-ms-timestamps.md) | Accepted |
| 30 | [No GraphQL API](0030-no-graphql.md)                                                       | Accepted |
| 31 | [`IDatabase` residue is intentional, not tech debt](0031-idatabase-residue-intentional.md) | Accepted |
| 32 | [PPF v1 uses zod schemas, not JSON Schema](0032-ppf-v1-zod-schemas.md)                     | Accepted |
| 33 | [pgvector HNSW: m=16, ef_construction=64](0033-pgvector-hnsw-params.md)                    | Accepted |
| 34 | [Subscription gate fails closed (402), no silent degradation](0034-subscription-gate-fails-closed.md) | Accepted |
| 35 | [Knowledge bulk import dedupes via SHA-256 content fingerprint](0035-bulk-import-sha256-fingerprint.md) | Accepted |
| 36 | [Drift threshold defaults: 0.15 warning / 0.30 critical](0036-drift-threshold-defaults.md) | Accepted |
| 37 | [SSE for one-way push, WebSocket for bidirectional only](0037-sse-vs-websocket-routing.md) | Accepted |
| 38 | [DAST runs passive baseline only, not full scan](0038-dast-passive-baseline.md)            | Accepted |
| 39 | [ZAP DAST first-run uses fail_action: false (collect mode)](0039-zap-fail-action-collect-mode.md) | Accepted |
| 40 | [SLO addon is a kustomize Component (not a Kustomization)](0040-slo-addon-as-component.md) | Accepted |
| 41 | [ArgoCD sync waves: 6-band (-10 / -5 / 0 / 5 / 10 / 15)](0041-argocd-sync-waves-6-band.md) | Accepted |
| 42 | [Web a11y testing uses playwright-axe, not vitest-axe](0042-playwright-axe-over-vitest-axe.md) | Accepted |
| 43 | [i18n CJK literal allowlist via `// i18n-allow-cjk:` pragma](0043-i18n-cjk-allowlist-pragma.md) | Accepted |
| 44 | [Kubernetes NetworkPolicy: default-deny + per-workload allow](0044-networkpolicy-default-deny.md) | Accepted |
| 45 | [Pod Security Admission: `restricted` enforce + dev reverse-assertion](0045-psa-restricted-with-reverse-assertion.md) | Accepted |
| 46 | [Dual-product split: Enterprise governance + ChronoCompanion (C-end)](0046-dual-product-companion.md) | Accepted |
| 47 | [The LLM is a distillable teacher, not a runtime dependency](0047-llm-as-distillable-teacher.md) | Accepted |

The first 31 records were back-filled in P1.5 to cover kernel
architecture, storage, agent layer, deployment, and product policy.
EP-2.3 added 14 more in 2026-05 covering decisions formed during
P0/P1: PPF v1 / pgvector HNSW / subscription gate / bulk-import
dedupe / drift thresholds / SSE-vs-WebSocket on the os side, plus
the cross-repo infrastructure decisions (DAST baseline, ZAP collect
mode, SLO Component, sync waves, playwright-axe, i18n CJK pragma,
NetworkPolicy default-deny, PSA restricted) that landed across
`chrono-synth-deploy` and `chrono-synth-web`. Cross-repo ADRs follow
the precedent of ADR-0020/0021: scope field names the actual repo
path; the os repo serves as the organisation-level ADR registry.

New decisions land as 0048+ following the same MADR-lite template
(see `0001-kernel-zero-runtime-deps.md`).
