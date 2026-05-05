# 0007 — Version-aware `commitImport`

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `src/portability/importer.ts`, `packages/kernel/src/uow`

## Context

Once portability packs ([ADR 0006](0006-portability-pack-v1.md)) are in
the wild, users will import packs that were exported by older versions of
the service — versions with different schemas, different value taxonomies,
even different memory shapes. The importer can't assume the pack matches
the current schema.

The naïve approach — "transform the pack into current shape before
writing" — has two bugs:

1. The transformation is one big unversioned function that grows as we
   add new versions; old branches rot.
2. Mid-import failure (disk full, conflicting unique key) leaves the
   target tenant in a half-imported state.

## Decision

`commitImport(pack, tx)` is **version-aware**: it reads the pack's
declared `chronosynth:version` and dispatches to a chain of small,
single-version migrators. Each migrator transforms `vN` to `vN+1` and is
small enough to read in one sitting. The chain stops at the current
version, and the result is written inside a single transaction
([ADR 0002](0002-sync-write-unit-of-work.md)).

If any step fails — schema validation, FK violation, disk error — the
transaction rolls back and the tenant is unchanged. There is no
half-import state.

The migrator chain lives in `src/portability/migrators/` with one file
per version step (`v1-to-v2.ts`, `v2-to-v3.ts`, …). Adding a new schema
version means adding one file and one entry in the dispatch map.

## Consequences

**Wins**

- Imports of any historical pack version succeed or fail atomically.
- Each migrator is testable in isolation; we keep golden packs of each
  version in `test/fixtures/portability/`.
- Removing a migrator is an explicit decision — old packs that depend on
  the dropped version produce a clean error message ("upgrade your
  source instance to ≥v3 first") instead of silent data loss.

**Costs**

- Every schema change costs us a migrator. The chain has 4 entries today
  and is expected to stabilize at ~10. Each is <100 LOC.
- We must keep test fixtures of every shipped version forever. Adds ~5
  MB to the test corpus per version; fine.

## Alternatives considered

- **One big "convert anything" function:** rejected — already tried; got
  to 800 LOC, no one understood it end to end.
- **Refuse to import packs older than the current version:** rejected —
  defeats the portability promise. We commit to importing every pack
  format we ever shipped, period.

## Related

- [0006 — Portability pack v1](0006-portability-pack-v1.md)
- [0002 — SyncWriteUnitOfWork](0002-sync-write-unit-of-work.md)
