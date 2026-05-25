# apps/companion-web — ChronoCompanion Web (placeholder)

> 🧭 Per [ADR-0046](../../docs/adr/0046-dual-product-companion.md), this
> directory will hold the **web host for ChronoCompanion** (the consumer-
> facing C-end product). **Today it is intentionally an empty placeholder**.
> Build kicks off in Phase 2 of
> [`docs/plan/companion-roadmap.md`](../../docs/plan/companion-roadmap.md),
> after Enterprise GA closes.

## Why this directory exists today

ADR-0046 locked the decision to ship two products from one codebase
(Enterprise governance + ChronoCompanion). The companion mobile app
(`apps/mobile/`) and desktop companion mode (`apps/desktop/`) inherit
existing skeletons. The web host is the only one without a skeleton, so
this placeholder reserves the path before any work starts — preventing
future "where does companion web live" thrashes.

## Planned stack (Phase 2)

| Layer | Decision (ADR-0046 D3) |
|-------|------------------------|
| Framework | React 19 + Vite 8 (same stack as `chrono-synth-web`) |
| Shared packages | `@chrono/contracts` + `@chrono/design-tokens` + `@chrono/sync-engine` |
| Routes | Independent from `chrono-synth-web` — different brand, navigation, pricing |
| PWA | Yes — service worker for offline + maskable icons + install-to-home |
| Brand colors | Will diverge from enterprise; design tokens get a `tokens.companion.*` namespace |
| Domain (candidate) | `companion.wontlost.com` (final by marketing pre-Phase 4) |

## What is NOT planned to live here

- Authentication backend (lives in `chrono-synth-os`)
- Persona kernel (lives in `@chrono/kernel`)
- Native shell (mobile lives in `apps/mobile/`, desktop in `apps/desktop/`)
- Enterprise admin / SCIM / audit-log views (those stay in `chrono-synth-web`)

## Next steps (do not start until Enterprise v2.0.0 GA ships)

See `docs/plan/companion-roadmap.md` Phase 2.2 for the 3-screen
v0.1.0-alpha scope: Login / CompanionHome / Growth.
