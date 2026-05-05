# 0019 — React Native uses structural driver aliases, not runtime detection

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `packages/adapter-react-native`, mobile app target

## Context

`@chrono/kernel` is platform-agnostic ([ADR 0001](0001-kernel-zero-runtime-deps.md)),
but adapters need to wire the same kernel ports to platform-specific
implementations:

- **Storage** — IndexedDB on web, AsyncStorage / WatermelonDB / SQLite
  on RN, node:sqlite on Node.
- **Crypto** — `crypto.subtle` on web, `react-native-quick-crypto` on
  RN, node:crypto on Node.
- **Network** — `fetch` everywhere, but RN's `fetch` lacks `keepalive`.

A common React Native pattern is runtime detection:

```ts
const storage = Platform.OS === 'ios' ? iosStorage : androidStorage;
```

This works for two reasons we wanted to avoid: it requires the kernel
to know about RN, and it gates code paths on a string compare on
every call.

## Decision

**Use TypeScript module resolution to alias drivers at build time.**
The adapter ships:

```
packages/adapter-react-native/
  src/
    drivers/
      storage.ios.ts
      storage.android.ts
      storage.ts          // re-exports based on Metro / RN resolver
      crypto.ts
```

Metro (RN's bundler) resolves `storage.ios.ts` on iOS and
`storage.android.ts` on Android via its built-in platform extension
support. The kernel imports `storage.ts`; the bundler picks the right
file at compile time. No `Platform.OS` branches in hot paths.

For drivers that don't have native platform extensions in Metro
(crypto, network), the package exposes a small factory function so
the consumer wires the right driver during app bootstrap.

## Consequences

**Wins**

- Kernel code paths are platform-blind. Same call site, different
  build artifact.
- Bundle splitting works: iOS doesn't ship Android driver code.
- TypeScript catches missing platform implementations at build
  time (a missing `storage.ios.ts` is a type error, not a runtime
  surprise).
- Test isolation is straightforward — `kernel-testkit` provides
  in-memory drivers, no platform shims needed.

**Costs**

- Two drivers per port to maintain (iOS + Android). We accept this:
  the surface is small (~5 ports), the iOS/Android divergence is
  real (e.g., AsyncStorage's quota differs), and a unified driver
  would just paper over those differences.
- Metro's platform-extension support is a private contract we
  depend on. We pin Metro version in package.json to avoid
  surprise breaks; a regression test exercises both platforms in
  CI via the adapter's own integration suite.

## Alternatives considered

- **Runtime `Platform.OS` switch**: rejected — see context.
- **Shared driver with conditional `if (Platform.OS === 'ios')`**:
  rejected — branches inside hot paths and ships dead code on
  each platform.
- **Single AsyncStorage driver for both platforms**: rejected —
  WatermelonDB on Android has materially better performance for
  our memory-heavy access pattern; we don't want to give that up
  to flatten the file tree.

## Related

- [0001 — Kernel zero deps](0001-kernel-zero-runtime-deps.md)
- [P2 mobile in plan](#) — separate epic
- `packages/adapter-react-native/src/drivers/`
