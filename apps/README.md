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

ADR-0046 D2 picked monorepo over per-app repos, and [ADR-0049](../docs/adr/0049-consolidate-app-hosts-into-monorepo.md)
finished the job by merging the last two holdouts (`chrono-synth-web` →
`apps/web`, `chrono-synth-desktop` → `apps/desktop`):
- `apps/*` consume `@chrono/kernel` + `@chrono/contracts` + `@chrono/sync-engine`
  + `@chrono/design-tokens` via **workspace** deps (`*`). The old standalone repos
  vendored those packages' `dist/` and drifted; workspace deps remove that.
- All hosts share the same backend (`chrono-synth-os`). A route-schema change
  needs host updates; a cross-repo PR is painful.
- Issue tracker / CI / dependabot all stay in one place.

The trade-off is that `chrono-synth-os` becomes the org-level monorepo. The
only remaining separate repo is **`chrono-synth-deploy`** (independent deploy
pipeline). `chrono-synth-web` / `chrono-synth-desktop` are archived (ADR-0049).
New product hosts go under `apps/` here.
