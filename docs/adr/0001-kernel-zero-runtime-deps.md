# 0001 — Kernel has zero runtime dependencies

**Status:** Accepted
**Date:** 2025-Q4 (back-filled 2026-05)
**Scope:** `packages/kernel`

## Context

Chrono Synth OS targets four runtimes — Node.js, browser via a Web Worker,
Tauri (desktop, embedded WebView), and React Native (mobile, Hermes). The
domain logic — value-graph evolution, persona simulation, memory recall — has
to behave identically on all four, including in offline mode on a phone.

Pulling in even small npm packages (e.g. `uuid`, `zod`, `lodash-es`) means
each adapter ships a different transitive tree, fights with native
polyfills, and risks subtle behavior drift across platforms. Mobile in
particular is allergic to Node-isms; React Native's Hermes does not ship
`process`, `Buffer`, or `crypto` in the shape Node packages assume.

## Decision

`@chrono/kernel/package.json` has **no `dependencies` and no `peerDependencies`
field**. Anything the kernel needs from the host — randomness, time, storage,
hashing, network, encryption — comes through a host-supplied port (an
interface defined by the kernel and implemented per adapter).

This is enforced two ways:

1. CI runs `npm ls --omit=dev --prefix packages/kernel` and fails if the
   tree contains anything beyond the kernel itself.
2. The package's `tsconfig` does not pull `@types/node`; using a Node global
   would break the build.

## Consequences

**Wins**

- Identical bytes ship to every adapter; differential bugs become near-zero.
- Mobile bundles stay small (kernel is ~40 KB gzipped).
- Supply-chain risk for the domain core is bounded to TypeScript itself.
- Upgrading the platform is a single PR; no ecosystem coordination.

**Costs**

- The kernel re-implements primitives that npm already solves (UUID v7,
  CRC32, deep-equal). We accept this — the implementations are <50 LOC each
  and read by everyone on the team.
- Adapters take on more weight. Each adapter must wire all kernel ports
  before the kernel is usable. This is the right place for that complexity.

## Alternatives considered

- **Allow a small "approved" dep list (uuid, zod):** rejected — every
  exception is a future fight. The bright line is easier to defend.
- **Separate kernel-node / kernel-web / kernel-mobile builds:** rejected —
  the whole point is a single domain core. Three builds means three subtle
  bug surfaces.

## Related

- [0008 — `IDatabase` implements `SyncWriteUnitOfWork`](0008-idatabase-implements-uow.md)
- `packages/kernel/README.md` — port catalog
