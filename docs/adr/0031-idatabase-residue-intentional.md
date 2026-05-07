# 0031 — `IDatabase` residue is intentional, not tech debt

**Status:** Accepted
**Date:** 2026-05-08
**Scope:** every file under `src/` that still imports `IDatabase` after Phase 2 UoW migration

## Context

The "Phase 2 UoW migration" project (commits `7168aac`, `611221e`, `5b00b91`,
`3204a0f`, `5c16ef9`, `201820e`, `69984c7`, `69a7c65`, `93c7501`, `55cd30b`,
`cd5e1f6`, summarized in `.claude/plan/status-2026-05.md`) moved domain
services from holding `IDatabase` directly to holding the narrower
`SyncWriteUnitOfWork` port. The original Phase 2 plan quoted "329 files
to migrate". After the dust settled, ~60 files still import `IDatabase`.

A future engineer skimming `git grep IDatabase` and reading the Phase 2
plan will reasonably wonder: *did they finish?* This ADR is the explicit
answer: **yes, Phase 2 is complete; the remaining `IDatabase` imports
are at architectural boundaries where the UoW abstraction does not
fit, and tightening them further would do more harm than good**.

## Decision

`IDatabase` is the **adapter boundary type**. Code that lives at or
outside the boundary is allowed (and in some cases required) to hold it.
Code inside the kernel-facing domain layer holds `SyncWriteUnitOfWork`.

The legitimate residue falls into five categories. Files matching any
of these may keep `IDatabase`; files outside them should hold
`SyncWriteUnitOfWork`.

### 1. Fastify routes and plugins (`src/server/**`)

HTTP routes are themselves adapters — they translate JSON bodies
into domain calls and back. A route's responsibility includes
constructing the database-bearing services it forwards to, so it
takes an `IDatabase` parameter and passes it through.

Routes never call `put`/`delete`/`commitImport` directly; they
inject the IDatabase into the right service constructor and the
service uses its UoW interface internally.

### 2. Transaction-hosting workers (`src/observability/**`, `src/queue/**`,
   `src/workers/**`, `src/data-plane/sqlite-event-ledger.ts`,
   `src/data-plane/persona-core-dual-write.ts`)

These call `db.transaction(() => {...})` to atomically pair a
write with a follow-up bookkeeping write (e.g. "publish event +
mark as sent"). `SyncWriteUnitOfWork` is single-write by design —
exposing `transaction()` on it would leak SQLite-shaped semantics
to every domain call and break the multi-runtime story (a Web
Worker target may not have nested transactions; a future RN
target may have a different transaction model entirely).

### 3. Health probes (`src/server/routes/health.ts`,
   `src/observability/observability-worker-monitor.ts`)

These call `db.prepare('SELECT 1').get()` to confirm the database
is reachable. A `SELECT 1` probe has nothing to do with
domain logic; promoting it to UoW would be conceptually wrong.

### 4. Txn-context containers (`src/multi-tenant/tenant-database.ts`,
   `src/multi-tenant/tenant-os-factory.ts`)

These wrap an existing `IDatabase` and produce **another** `IDatabase`
that automatically rewrites tenant_id on every query. They're the
factory that builds the UoW-compatible thing, not consumers of UoW.

### 5. Cross-storage adapters (`src/enterprise/envelope-encryption.ts`,
   `src/enterprise/kms-key-audit.ts`, `src/data-plane/tenant-vault.ts`,
   `src/data-plane/storage-provider-resolver.ts`,
   `src/data-plane/platform-key-resolver.ts`,
   `src/privacy/{export-job,import-token,conflict-inbox}-store.ts`)

These services use `db.prepare(...)` for reads that don't fit the
narrow UoW write port. UoW intentionally exposes only `put`/`delete`/
`commitImport`. Reads stay on `IDatabase` until the kernel has its
own read-port abstraction (open question; not in scope).

### 6. Domain services that intentionally use `db.prepare()` for reads

A handful of domain files (`src/core/memory-graph.ts`,
`src/core/memory-facade.ts`, `src/safety/persona-drift-analyzer.ts`,
`src/intelligence/{token-budget,cost-tracker,embedding-index}.ts`)
hold `IDatabase` only to issue read queries via `db.prepare(...)`.
Phase 2 deliberately stopped here. The kernel's UoW is a **write**
port; promoting reads into it would either:

- (a) let the kernel see SQLite-shaped query strings, defeating the
  zero-dep + portable design captured in [ADR-0001](0001-kernel-zero-runtime-deps.md), or
- (b) require a parallel `RuntimeAdapter` interface introducing
  `query<T>(spec)` semantics that no other runtime currently
  drives.

Either path adds large surface area for no demonstrated need. The
narrow UoW write port plus pragmatic `IDatabase` reads is the
chosen equilibrium.

## Consequences

**Wins**

- Phase 2's stated goal (kernel zero-dep + multi-runtime portability)
  is achieved. `packages/kernel/src` has zero `node:sqlite` /
  `better-sqlite` references; the kernel-zero-deps contract test
  enforces this.
- Domain services that have natural UoW shapes (single-write,
  identity-keyed) live behind the UoW port and migrate cleanly to
  Web/Tauri/RN adapters.
- Adapter-boundary code (routes, workers, multi-tenant rewriters)
  keeps the rich `IDatabase` API where it actually needs it,
  without an artificial wrapper.

**Costs**

- `git grep IDatabase` returns dozens of hits, even though Phase 2
  is done. Mitigated by this ADR + by `.claude/plan/status-2026-05.md`
  Phase 2 section.
- New code in domain services has to pick: `IDatabase` for reads vs
  `SyncWriteUnitOfWork` for writes. The convention is to take both
  if both are needed, named `db` and `uow`. Slightly verbose but
  unambiguous.

## Alternatives considered

- **Force every IDatabase import out via `RuntimeAdapter` interface:**
  rejected. Would require defining `query`, `transaction`, `health`,
  `prepare` semantics that work across SQLite / IndexedDB / RN
  AsyncStorage / future Web Workers. None of those targets currently
  drive a real requirement; speculative abstraction.

- **Block reads on the kernel UoW too:** rejected. Reads inside
  `core/memory-graph.ts` and `safety/persona-drift-analyzer.ts`
  are domain logic. They need real query power that `db.prepare()`
  gives. Forcing them through the kernel write port (or through a
  precomputed projection) would either invent a fake write event
  for every read, or push the projection store into being a
  shadow database. Both are worse than the status quo.

- **Quote a smaller "files migrated" success number:** rejected. The
  Phase 2 plan's "329 files" was inflated by counting tests and
  storage adapters. The real domain migration target was ~60 files,
  of which 60+ migrated cleanly and 13 stayed by design. A dishonest
  number now would breed more confusion than the residue does.

## How to enforce going forward

- New domain services: take `SyncWriteUnitOfWork` for writes. If the
  service also needs reads, take `IDatabase` separately as a second
  parameter named `db`. Don't reach into IDatabase from a service
  that doesn't legitimately need read query power.

- New adapter-boundary code (routes, plugins, workers): take
  `IDatabase` as before.

- If a domain service starts wanting `db.transaction()`, either
  refactor it to live behind a worker (Category 2 above) or open a
  follow-up ADR to revisit this decision. Don't quietly add
  `transaction()` to UoW.

## Related

- [ADR-0001 — Kernel zero runtime deps](0001-kernel-zero-runtime-deps.md)
- [ADR-0002 — SyncWriteUnitOfWork is sync-only](0002-sync-write-unit-of-work.md)
- [ADR-0008 — `IDatabase` implements `SyncWriteUnitOfWork`](0008-idatabase-implements-uow.md)
- `.claude/plan/status-2026-05.md` Phase 2 section — narrative version
- Commit `55cd30b` — "kill the bridge"
- Commit `cd5e1f6` — `src/observability/` leaf-surface UoW migration
