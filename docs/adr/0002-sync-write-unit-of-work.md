# 0002 — `SyncWriteUnitOfWork` is sync-only

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `packages/kernel/src/uow`, all adapter database drivers

## Context

The kernel runs domain logic that's intrinsically transactional: a single
"tick" might write a memory, decay a value weight, append an audit row, and
update an index — all of which must succeed or fail together.

Every mainstream JavaScript ORM exposes write APIs as `Promise`-based. That
forces every domain method that touches storage to be `async`, which then
infects every caller, all the way up to the request handler. Worse, an
`await` inside a transaction yields the event loop and lets unrelated work
sneak in between two writes that the domain considers atomic.

## Decision

The kernel defines `SyncWriteUnitOfWork`, an interface whose write methods
are **synchronous functions** (not Promises). Adapters open a transaction
asynchronously, then run a sync callback inside it, then commit
asynchronously:

```ts
await db.tx((uow) => {
  uow.put('memory', record);   // sync
  uow.put('audit', auditRow);  // sync
  uow.commitImport(...);       // sync
});
```

Reads can still be async (range scans on a remote DB are allowed to await).
But once a transaction has started, every mutation inside it is sync.

## Consequences

**Wins**

- Domain code is `function`-shaped, not async — easier to test, easier to
  reason about ordering, no `await` between two writes that must be atomic.
- Better-sqlite3 (Node) and IndexedDB-with-microtask-fence (web) both map
  cleanly. Postgres maps via a per-connection pipeline that buffers writes
  and flushes on commit.
- Aborts via thrown exception, not `tx.rollback()` — symmetry with try/catch.

**Costs**

- Postgres adapters look weird at first glance: every `uow.put` returns
  `{ rowsAffected: 1 }` immediately, but the actual write is queued and
  fails (asynchronously) on commit if the constraint is violated. We
  document this in the port doc and surface failures via the awaited
  `db.tx` resolution.
- A single tx can't pull data mid-flight from a remote source; reads must
  happen before the tx opens. This is a feature, not a bug — it forces
  callers to fetch their inputs upfront.

## Alternatives considered

- **All-async UoW:** rejected — the original design. Three months in we had
  five separate "consistency bugs" that were all an `await` slipping into a
  domain method.
- **Generator-based "fake sync":** rejected — clever, hard to debug, fights
  the type system.

## Related

- [0008 — `IDatabase` implements `SyncWriteUnitOfWork`](0008-idatabase-implements-uow.md)
- [0015 — Kernel commands return `{ rowsAffected }`](#) (planned)
