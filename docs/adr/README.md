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

P1.5 closed: 30 records covering kernel architecture, storage, agent
layer, deployment, and product policy. New decisions land as 0031+
following the same MADR-lite template (see `0001-kernel-zero-runtime-deps.md`).
