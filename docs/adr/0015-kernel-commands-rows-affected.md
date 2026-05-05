# 0015 — Kernel commands return `{ rowsAffected }`, not `T`

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `packages/kernel/src/uow`, every executor

## Context

The kernel's command executors (`PTPL_CMD_INSERT`, `MEMORY_CMD_PUT`,
…) sit between the domain code and the storage adapter. The natural
TypeScript signature is generic:

```ts
function executeCommand<TParams, TResult>(name: string, params: TParams): TResult
```

So a `MEMORY_CMD_PUT` returns `Memory`, a `PTPL_CMD_DELETE` returns
`void`, a `PTPL_CMD_UPSERT_BUILTIN` returns... what?

Different storage drivers (better-sqlite3 sync, postgres async-but-
batched per [ADR 0002](0002-sync-write-unit-of-work.md)) return
different shapes. SQLite gives `{ changes, lastInsertRowid }`,
Postgres gives `{ rowCount }`. Forcing one of them into the kernel
means leaking driver semantics; rolling our own per-command shape
means N tiny return types and N callers parsing them.

## Decision

**Every kernel command returns `{ rowsAffected: number }`.** Nothing
more. If callers want richer data (the inserted row, the new ID),
they read it back via a query.

```ts
type CommandResult = { rowsAffected: number };

registerCommand<MemoryPutParams>(MEMORY_CMD_PUT, (db, p) => {
  const r = db.prepare(...).run(...);
  return { rowsAffected: r.changes };
});
```

Drivers normalize to this shape:

- `node:sqlite`: `r.changes`
- Postgres: `r.rowCount ?? 0`

Idempotent commands are recognizable by the caller checking
`rowsAffected === 0`; conflict-on-update commands return 1 (the
write happened) or 0 (the row already had matching content).

## Consequences

**Wins**

- One return shape across N commands. Caller code reads identically
  whether the command updates `core_values`, `tool_invocations`, or
  `agency_authorizations`.
- Driver-specific row metadata stays inside the driver. Adding a
  third driver doesn't fan out.
- "Did anything happen?" is a one-liner: `if (r.rowsAffected > 0)`.
- TypeScript signature stays simple — no generics, no per-command
  type drift.

**Costs**

- Some commands genuinely want to return inserted IDs. They have
  to do a follow-up query. The cost is one extra round-trip on
  the hot path; we use `RETURNING` clauses in postgres adapters
  where it matters and accept the sqlite asymmetry (`lastInsertRowid`
  is per-prepared-statement, not portable).
- A command that updates 7 rows looks identical to one that updates
  1. Where the count matters semantically (e.g., "delete all
  expired tokens; how many?"), the result is fine. Where it doesn't
  (e.g., "set this one row"), we ignore it.

## Alternatives considered

- **Generic `T` return type**: rejected — N return types means N
  drivers must produce them, and adapters drift.
- **Driver-native return passed through**: rejected — couples the
  kernel to one driver's vocabulary.

## Related

- [0002 — SyncWriteUnitOfWork](0002-sync-write-unit-of-work.md)
- [0008 — IDatabase implements UoW](0008-idatabase-implements-uow.md)
