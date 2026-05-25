# apps/ — Application hosts on top of `@chrono/kernel`

> Per [ADR-0046](../docs/adr/0046-dual-product-companion.md), ChronoSynth
> ships two products from this codebase. The hosts below are how each
> product reaches users; the kernel and backend are shared.

| Host | Status | Product | Notes |
|------|--------|---------|-------|
| [`mobile/`](mobile/README.md) | PoC (4 screens), expanding to production in roadmap Phase 2 | **ChronoCompanion** (primary mobile host) | Expo + RN; iOS + Android |
| [`desktop/`](desktop/) | Enterprise PoC live; companion mode planned (roadmap Phase 2.4) | Both — same binary, plan-based UX | Tauri 2; macOS / Windows / Linux |
| [`companion-web/`](companion-web/README.md) | Placeholder | **ChronoCompanion** (web fallback) | React 19 + Vite 8; planned Phase 2.2 |

> The **enterprise web console** lives in the sibling repo
> [`chrono-synth-web`](https://github.com/wontlost-ltd/chrono-synth-web),
> not here. The two web hosts are deliberately split: different brand,
> different routing, different pricing.

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
