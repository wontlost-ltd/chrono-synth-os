# apps/ — Application hosts on top of `@chrono/kernel`

> Per [ADR-0046](../docs/adr/0046-dual-product-companion.md), ChronoSynth
> ships two products from this codebase. The hosts below are how each
> product reaches users; the kernel and backend are shared.

| Host | Status | Product | Notes |
|------|--------|---------|-------|
| [`web/`](web/README.md) | Production (enterprise console) | **Enterprise governance** | React 19 + Vite 8; merged in from `chrono-synth-web` (ADR-0049) |
| [`desktop/`](desktop/README.md) | Enterprise app live; companion mode planned (roadmap Phase 2.4) | Both — same binary, plan-based UX | Tauri 2 + SQLCipher; macOS / Windows / Linux; merged in from `chrono-synth-desktop` (ADR-0049) |
| [`companion-web/`](companion-web/README.md) | v0.1.0-alpha (Home/Growth/Memories) | **ChronoCompanion** (C-end web) | React 19 + Vite 8 |
| [`mobile/`](mobile/README.md) | PoC (RN 0.76 / React 18) | **ChronoCompanion** (primary mobile host) | Expo + RN; iOS + Android; ⚠️ not yet wired into workspace (see ADR-0049 遗留) |

> Per [ADR-0049](../docs/adr/0049-consolidate-app-hosts-into-monorepo.md), the
> **enterprise web console** (`web/`) and **desktop** (`desktop/`) were merged
> in from their former sibling repos (`chrono-synth-web` / `chrono-synth-desktop`),
> eliminating vendoring. They consume `@chrono/*` via workspace deps now.
> Only `chrono-synth-deploy` remains a separate repo.

## Why these are inside `chrono-synth-os` (not separate repos)

ADR-0046 D2 picked monorepo over per-app repos because:
- `apps/*` consume `@chrono/kernel` + `@chrono/contracts` + `@chrono/sync-engine`
  + `@chrono/design-tokens` via `file:` workspace deps. Pulling them out into
  separate repos would mean publishing those packages on every kernel change.
- All three hosts share the same backend (`chrono-synth-os`). A change to a
  route schema needs to update host code; a cross-repo PR is painful.
- Issue tracker / CI / dependabot all stay in one place.

The trade-off is that `chrono-synth-os` becomes the org-level monorepo. The
sibling `chrono-synth-web` / `chrono-synth-desktop` / `chrono-synth-deploy`
repos remain because they pre-date `apps/` and their CI / release pipelines
are independently load-bearing. New product hosts go under `apps/` here.
