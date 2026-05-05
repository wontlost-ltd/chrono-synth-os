# @chrono/kernel

> Pure-domain kernel for the Chrono Synth digital persona system.
> Zero runtime dependencies. Designed to run on Node.js, browsers, Web Workers, Tauri, and React Native — anywhere a host can supply a `SyncWriteUnitOfWork` adapter.

License: MIT (see `LICENSE`).

---

## What this package is

`@chrono/kernel` contains the domain model, command/query algebra, error types, and ports (interfaces) that define the Chrono Synth persona system. It does **not** contain:

- Database drivers (SQLite, IndexedDB, etc.)
- Network clients (HTTP, Kafka, Stripe, etc.)
- Encryption primitives (those live in host adapters)
- Any I/O at all — the kernel is a pure-data, pure-logic library

A host application brings the runtime by implementing the **`SyncWriteUnitOfWork`** port and registering executors for each `Command` / `Query` kind the kernel issues.

## What this package guarantees

| Property | How it's enforced |
|----------|-------------------|
| Zero runtime dependencies | `package.json` has no `dependencies` block; all imports resolve relative or to peer `@chrono/*` packages |
| No `node:*` imports | Verified by `npm run check:forbidden-imports` from the host repo |
| No I/O / no globals leaked | All side effects flow through caller-supplied UoW + ports |
| Deterministic | Given the same UoW state and inputs, every kernel function is referentially transparent |

This makes the kernel safe to ship into:

- A Web Worker thread (no `node:` APIs)
- A Tauri Rust backend (via a bridge that implements `SyncWriteUnitOfWork`)
- A React Native runtime (Expo SQLite or AsyncStorage adapters)
- Server-side Node.js (today's primary host)

## Install

```bash
# Inside the chrono-synth monorepo workspace:
npm install --workspace=@chrono/kernel
```

External installation (post-publish; not yet on npm):

```bash
npm install @chrono/kernel
```

## Quick start

The kernel exposes Commands (writes) and Queries (reads) as plain values. A host implements the executor for each `kind`:

```ts
import {
  type SyncWriteUnitOfWork,
  type Command,
  type Query,
  uoauthCmdUpsert,
  tpermQueryByPersonaTool,
} from '@chrono/kernel';

// 1. Host provides a UoW (this example: a wrapper around better-sqlite3)
const tx: SyncWriteUnitOfWork = makeSqliteUoW();

// 2. Issue a command
const result = tx.execute(uoauthCmdUpsert({
  id: 'uoauth_1',
  tenantId: 'default',
  userId: 'user_a',
  provider: 'google',
  scope: 'https://www.googleapis.com/auth/calendar',
  accessTokenEncrypted: '...',
  refreshTokenEncrypted: '...',
  accessExpiresAt: Date.now() + 3600_000,
  now: Date.now(),
}));
console.log('rows affected:', result.rowsAffected);

// 3. Issue a query
const perm = tx.queryOne(tpermQueryByPersonaTool({
  tenantId: 'default',
  personaId: 'persona_1',
  toolId: 'web_search',
}));
```

The shape of `Command` and `Query`:

```ts
interface Command<P> { readonly kind: string; readonly params: P; }
interface Query<R, P> { readonly kind: string; readonly params: P; }
```

The host registers an executor per `kind`. The kernel never imports a database — it only emits these objects.

## Domain coverage

Top-level exports include:

- `domain/identity/` — users, tenants, sessions, OAuth tokens
- `domain/persona/` — persona core, cognitive memory, snapshots
- `domain/core-self/` — values, narratives, anchors, decision styles, memory
- `domain/billing/` — subscriptions, settlements, usage
- `domain/agent/` — tool permissions, agency authorizations, tool invocations, MCP types
- `domain/observability/` — outbox, rollups, metrics queries
- `domain/queue/` — task queue, idempotency
- `domain/intelligence/` — LLM provider types, persona state
- `domain/simulation/` — life simulation primitives
- Shared: `errors`, `circuit-breaker`, `math`, `config-metadata`

## Versioning

This package follows semver. Breaking changes to any exported `kind` constant or `params` shape ship as major versions. The host's executor registry is responsible for handling kernel-version skew during deploys.

## Related packages

- `@chrono/contracts` — Zod schemas for cross-service API payloads
- `@chrono/sync-engine` — sync state machine
- `@chrono/design-tokens` — design tokens for the UI

## Status

`0.1.0` — internal monorepo use. A public `1.0.0` release blocks on the [Persona Portable Format (PPF) v1 specification](../../docs/ppf/v1/spec.md), which fixes the wire format for cross-instance persona migration.
