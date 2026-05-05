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

Future records (planned, see `.claude/plan/enterprise-readiness-2026.md` P1.5):

11. core_values single-row PK · 12. agency-authorization vs tool-permission ·
13. confirmation tokens don't persist arguments · 14. integration tests use
createMemoryDatabase · 15. kernel commands return `{rowsAffected}` ·
16. monorepo workspaces · 17. no Redux/Zustand in adapter-web ·
18. Tauri over Electron · 19. RN structural driver aliases ·
20. ArgoCD vs Flux · 21. kustomize vs Helm · 22. MIT kernel / AGPL enterprise ·
23. webhook shared-secret not signed · 24. no auto-restart on migration fail ·
25. JSON over YAML for runtime config · 26. Stripe over Paddle ·
27. no CLI · 28. audit_log per-tenant · 29. epoch ms timestamps ·
30. no GraphQL.
