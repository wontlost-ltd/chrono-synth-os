# 0017 — No Redux / Zustand / Pinia in `@chrono/adapter-web`

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `packages/adapter-web`, `chrono-synth-web` consumer

## Context

A typical React app reaches for a state library — Redux Toolkit,
Zustand, Jotai, MobX — to manage cross-component state. Chrono
Synth Web's UI surface is large (~50 routes, 200+ components), so
the question came up early: which library?

The honest answer the team kept circling back to: **none of them
solve the problem we have**. Our state lives in three places:

1. **Server state** — personas, simulations, billing — fetched from
   the API. React Query already manages this perfectly.
2. **Kernel state** — value graphs, memories, recall — sits in
   `@chrono/kernel` running in a Web Worker. The kernel maintains
   its own consistency via UoW; the UI subscribes to its events.
3. **UI ephemeral state** — open/closed flags, drafts, focus —
   already at home in component-local `useState`.

A state library would just add a fourth, redundant, place. Its main
selling points (time-travel, devtools, middleware) don't apply: the
kernel is the truth, not a Redux store.

## Decision

**`@chrono/adapter-web` exports a `WebPersistenceController` and a
`WebUnitOfWork` shim — no global state library.** Pages compose:

- React Query for server state (`useSimulations`, `usePersonas`,
  `useBilling`).
- Direct kernel subscriptions through the adapter for kernel state.
- `useState` / `useReducer` for component-local UI flags.
- Tiny `useSession` Zustand-style hook in `src/store/session.ts`
  for auth — the *only* exception, justified by the cross-component
  read need that React context would also solve, but with worse
  ergonomics.

No `Provider` wrapper at the top of the tree, no global dispatch.

## Consequences

**Wins**

- Three sources of truth, each authoritative for its layer. No
  reconciliation logic between them.
- Adding a feature usually means a new query hook and a few
  components — never "where does this live in the store".
- The bundle is smaller: no Redux/Zustand/Jotai weight.
- New contributors don't learn a custom state shape; they learn
  React Query (which they probably already know).

**Costs**

- Cross-component coordination that *does* need shared state has
  to use either React context (verbose) or move to React Query
  with a synthetic key. The session hook is the one place we
  accepted a Zustand-shaped pattern, and even that is hand-rolled.
- Devtools are per-layer: React Query devtools for server state,
  the kernel adapter's own logger for kernel events. There is no
  unified time-travel.

## Alternatives considered

- **Redux Toolkit**: rejected — would duplicate React Query +
  the kernel.
- **Zustand**: rejected — same reason; the auth hook is the
  only legitimate use-case and we hand-rolled it.
- **Jotai / Recoil**: rejected — atomic stores don't pay for
  themselves at our scale.

## Related

- [0001 — Kernel zero deps](0001-kernel-zero-runtime-deps.md)
- `packages/adapter-web/src/WebUnitOfWork.ts`
- `chrono-synth-web/src/store/session.ts` (the one exception)
