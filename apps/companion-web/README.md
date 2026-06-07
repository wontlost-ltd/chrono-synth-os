# apps/companion-web — ChronoCompanion Web (v0.1.0-alpha)

> 🧭 Per [ADR-0046](../../docs/adr/0046-dual-product-companion.md), this is the
> **web host for ChronoCompanion** (the consumer-facing C-end product) — the
> same shared kernel as Enterprise, a different shell.
>
> **Status:** v0.1.0-alpha proof slice. Built in parallel with the Enterprise
> beta→GA line (founder decision 2026-06-08: build Companion now, do **not**
> freeze Enterprise — keeps ADR-0046 D5 "two products, mutually non-blocking").

## What's here (alpha slice)

A minimal-but-real React SPA proving the "same kernel, C-end shell" loop:

| Screen | Reads | Shows |
|--------|-------|-------|
| 登录 (Login) | `POST /api/v1/auth/login` | email/password → holds access token in memory, sends `Authorization: Bearer` |
| 我的数字人 (Home) | `GET /api/v1/companion/me` | narrative + top values + recent memories |
| 成长 (Growth) | `GET /api/v1/companion/me/growth` | persona **drift rendered as「你最近探索的方向」**, not "policy violation" |

The Growth screen is the core ADR-0046 proof point: the *same* `DriftReport` the
Enterprise console renders as a governance alert is re-framed here as exploration
(roadmap Phase 2 exit criterion 5.2).

## Stack

| Layer | Choice |
|-------|--------|
| Framework | React 18.3.1 + Vite 8 |
| Types | `@chrono/contracts` (`companion-me.v1` / `companion-growth.v1`) — end-to-end type-safe, response validated at runtime against the same Zod schema the backend serializes with |
| Auth | `/api/v1/auth/login` → access token held in memory + `Authorization: Bearer`; 401 auto-refreshes once via the refresh cookie. Backend gate rejects `enterprise` plan **and** API-key principals (companion is user-session only). |
| PWA | `manifest.webmanifest` + maskable icon (service worker: follow-up) |
| Brand | independent dark palette in `src/styles.css`; migrate to `tokens.companion.*` design-token namespace when the slice expands |

> ⚠️ React is pinned to **18.3.1** to match the repo's existing React
> (`apps/mobile`), and `@vitejs/plugin-react@^5` is required for Vite 8 (plugin
> v4 caps at Vite 7). The roadmap's aspirational "React 19" is a deferred
> upgrade, not adopted here, to avoid a second React major in one monorepo.

## Develop

```bash
npm run dev          # Vite dev server; proxies /api → COMPANION_API_TARGET (default http://localhost:3000)
npm run typecheck    # tsc --noEmit
npm run test         # node:test (native TS) — auth session-layer unit tests (CSRF / single-flight / epoch)
npm run build        # production bundle → dist/
```

> The auth unit tests run on Node's native TS support (v24+) with stubbed
> `fetch`/`document`. Like `apps/mobile`/`apps/desktop`, this host runs in its
> own lane and is not yet wired into the repo's root `test:golden` (follow-up).

Run the backend (`chrono-synth-os`) separately; the dev server proxies `/api`
to it. Log in with a non-enterprise account to see your digital human. The
access token lives in memory only (a page refresh requires re-login; silent
re-auth via the refresh cookie on boot is a follow-up).

## Build independence

Like `apps/mobile`, this host is **not** part of the root `tsc -b` project
graph (it carries DOM/JSX libs; the Node build must stay clean). It self-builds
via Vite and self-typechecks via `npm run typecheck`.

## What does NOT live here

- Auth backend / persona kernel (in `chrono-synth-os` + `@chrono/kernel`)
- Native shells (`apps/mobile`, `apps/desktop`)
- Enterprise admin / SCIM / audit views (sibling repo `chrono-synth-web`)

## Next (roadmap Phase 2.2+)

- Vitest/jsdom lane for `api.ts` end-to-end 401-retry tests (the auth session
  layer + `decide401Action` are unit-tested today via `node --test`; the full
  `fetchMe()`→401→refresh chain isn't, because `api.ts` uses `.js` import
  specifiers that bare `node --test` can't resolve)
- Silent re-auth on boot via the refresh cookie (so a page refresh keeps the session)
- Service worker for offline
- `tokens.companion.*` design-token namespace
- Memory detail / persona tuning screens
