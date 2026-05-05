# 0003 — JSON kind constants over typed factories

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `packages/kernel/src/events`, `packages/contracts`

## Context

The system represents domain events (memory recorded, value updated, audit
emitted) as plain JSON records with a `kind: string` discriminator. Two
patterns competed during the v0.x design:

1. **Typed factories**: `createMemoryRecorded(payload)` → `MemoryRecordedEvent`
2. **Kind constants + zod**: `{ kind: KIND.MEMORY_RECORDED, ... }` validated
   at the boundary

We chose option 2 (with the constraint that `zod` is *not* in the kernel —
see [ADR 0001](0001-kernel-zero-runtime-deps.md)), so kernel uses
hand-written narrow type guards.

## Decision

- All event kinds live as string constants in `packages/contracts/src/kinds.ts`.
- The kernel exports type guards (`isMemoryRecorded(x): x is MemoryRecordedEvent`)
  generated from a single source of truth.
- Adapters that need runtime validation (HTTP boundary, sync engine ingress)
  use the contracts package's zod schemas, which are kept in lockstep with
  the kind constants by a `npm run check:kinds` test.

The kernel itself never imports zod. It accepts `unknown`, narrows via type
guards, and throws a typed `KernelError` on shape violation.

## Consequences

**Wins**

- A new event kind is one constant + one type guard + one schema = three
  small additions in three files. No factory file to maintain.
- Cross-package interop is trivial: `kind` is a string both sides recognize.
- Wire format == in-memory format — no serialization layer.
- The persisted event log can be migrated by a static SQL script; no need
  to rehydrate through a factory function.

**Costs**

- No exhaustiveness check at construction time. We accept this — the type
  guard at every entry point gives the same protection one layer up.
- The kind constant and schema can drift; `check:kinds` is a CI gate, not a
  compile-time guarantee.

## Alternatives considered

- **Typed factories**: rejected — every new event needs a new function, and
  in practice nobody used the factories; everyone wrote `{ kind, ... }`
  literals anyway. Two ways to do the same thing, only one used → cut the
  unused one.
- **Class hierarchies (`class MemoryRecordedEvent extends DomainEvent`)**:
  rejected — class instances don't survive `JSON.stringify`/`parse` round
  trips, breaking the persistence model.

## Related

- [0006 — Portability pack v1 (JSON-LD)](0006-portability-pack-v1.md)
- `packages/contracts/src/kinds.ts`
