# 0014 — Integration tests use `createMemoryDatabase()`

**Status:** Accepted
**Date:** 2025-Q3 (back-filled 2026-05)
**Scope:** `packages/kernel-testkit`, `src/test/integration/**`

## Context

There were three plausible places to draw the test line:

1. **Unit only** — mock every UoW call, never touch real storage.
2. **Mocks plus a tiny in-memory adapter only the kernel team
   maintains** — drift risk; the unit tests pass while production
   breaks because the mock got the SQL semantics wrong.
3. **A real database, in memory, exercised by the same code path
   production uses.**

We picked option 3. The `kernel-testkit` exports
`createMemoryDatabase()` — a `:memory:` SQLite instance wired
through the same `IDatabase` adapter that the prod node:sqlite
driver uses, with `applyAllMigrations()` run on first call.

## Decision

**Integration tests use `createMemoryDatabase()`. No mocked UoW.**

```ts
// src/test/integration/conversation-api.test.ts
import { createMemoryDatabase } from '@chrono/kernel-testkit';

const db = createMemoryDatabase();
const os = new ChronoSynthOS({ db, ... });
const app = await createApp({ os });
```

Every test gets a fresh database; teardown drops it. No fixtures
shared between tests. The full migration chain runs on each test
file's `beforeAll` (~50 ms warm-up).

Postgres-only behaviours are tested separately by the
`test-postgres` CI job (the suite under `src/test/integration`
runs against both drivers when `CHRONO_DB_DRIVER=postgres`).

## Consequences

**Wins**

- Integration tests catch real schema bugs: foreign keys, NOT
  NULL, CHECK constraints, unique violations. Mocked UoW would
  not.
- The same code path as production reduces "passes in test, fails
  on staging" surprises near zero.
- Migration chain test (every test creates a fresh DB) is implicit;
  if v069 breaks v062's index, every integration test fails on
  setup.
- Test isolation is automatic — fresh DB per test, no shared state.

**Costs**

- Test runtime is higher than mocked: ~50 ms migration warm-up
  per file × ~70 integration files ≈ 3.5 s total overhead. We
  accept this — the suite still completes in <90 s on CI.
- We can't unit-test "what if the DB is slow / broken / partitioned"
  without explicit fault injection. That layer lives in dedicated
  load + chaos tests.

## Alternatives considered

- **Mocked UoW**: rejected — see context.
- **Dockerized PostgreSQL per test**: rejected — too heavy for
  unit-level integration. We run that pattern only in the
  dedicated `test-postgres` CI job, which surfaces driver-specific
  bugs once per push.

## Related

- [0001 — Kernel zero deps](0001-kernel-zero-runtime-deps.md)
- [0008 — IDatabase implements UoW](0008-idatabase-implements-uow.md)
- `packages/kernel-testkit/src/createMemoryDatabase.ts`
