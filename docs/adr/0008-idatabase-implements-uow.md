# 0008 — `IDatabase` implements `SyncWriteUnitOfWork` directly

**Status:** Accepted
**Date:** 2026-Q1 (replaced an earlier "bridge" design)
**Scope:** `src/storage/database.ts`, `packages/kernel/src/uow`

## Context

Originally the storage layer had two interfaces:

- `IDatabase` — the rich top-level API (transactions, migrations, health).
- `SyncWriteUnitOfWork` — the narrow domain-facing UoW the kernel sees.

Adapter code created an `IDatabase` and then wrapped it in a separate
`UoWBridge` whenever it crossed into kernel territory. The bridge added
no behavior — it just forwarded `put`/`delete`/`commitImport` calls.

Two months in, the bridge had collected enough subtle "almost identical
but not quite" bugs (different transaction isolation, slightly different
error mapping) that we'd lost the supposed benefit of separation.

## Decision

**`IDatabase` directly `implements SyncWriteUnitOfWork`.** There is no
bridge class. The kernel-facing methods live on the same object as the
adapter-facing methods; the kernel's type accepts only the UoW subset.

```ts
class Database implements IDatabase, SyncWriteUnitOfWork {
  // adapter-only
  migrate(): Promise<void>;
  health(): HealthReport;
  // UoW (visible to kernel)
  put(kind: string, record: unknown): { rowsAffected: number };
  delete(kind: string, id: string): { rowsAffected: number };
  commitImport(...): { rowsAffected: number };
}

// Kernel signature
function recordMemory(uow: SyncWriteUnitOfWork, m: Memory) { ... }
```

The kernel sees only what TypeScript's structural typing exposes —
calling `migrate()` from inside the kernel is a compile error.

## Consequences

**Wins**

- One implementation of the put/delete/commit semantics, not two. The
  bridge bugs are gone because there is no bridge.
- Less code: ~200 LOC removed across all adapters.
- TypeScript still enforces the kernel's narrow view; the protection
  comes from the type signature, not from a runtime adapter.
- Performance: one less indirection on the hot path.

**Costs**

- The `Database` class is wider; readers have to keep in mind which
  methods are kernel-visible. We mitigate with a `// region: UoW` comment
  block convention.
- Mocking for tests is slightly clumsier — you mock more surface than
  you exercise. We use the kernel-testkit's `createMemoryDatabase()`
  which gives a real (in-memory) instance, so this rarely bites.

## Alternatives considered

- **Keep the bridge, fix the bugs:** rejected — the bridge had no
  conceptual reason to exist beyond "two interfaces felt cleaner". Two
  interfaces did not, in fact, feel cleaner.
- **Compose UoW out of free functions, no class:** rejected — would have
  required passing five capability handles into every kernel call.

## Related

- [0001 — Kernel zero deps](0001-kernel-zero-runtime-deps.md)
- [0002 — SyncWriteUnitOfWork](0002-sync-write-unit-of-work.md)
- Commit `55cd30b` — "kill the bridge"
