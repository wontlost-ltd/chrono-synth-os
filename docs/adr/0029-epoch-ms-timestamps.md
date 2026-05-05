# 0029 — All timestamps are epoch milliseconds (`number`), not strings

**Status:** Accepted
**Date:** 2025-Q3
**Scope:** every persisted row, every wire payload

## Context

Time representation is one of those decisions that has to be made
once, early, and stuck with. Common options:

1. **ISO 8601 strings** (`"2026-05-05T11:23:45Z"`)
2. **Epoch seconds** (`1746449025`)
3. **Epoch milliseconds** (`1746449025123`)
4. **Postgres `timestamptz`** with driver-managed conversion

Each table that gets it wrong needs a future migration. Each API
endpoint that returns the wrong shape locks every client to that
shape forever.

## Decision

**Epoch milliseconds, JS `number`.** Every `*_at` column is
`INTEGER NOT NULL` (or nullable for soft-delete fields). Every API
field is a JSON number.

```ts
interface Memory {
  id: string;
  recordedAt: number;   // epoch ms
  expiresAt: number | null;
}
```

We use `Date.now()` to produce them, `new Date(ms)` to consume them
in the UI, and `console.log(new Date(ms).toISOString())` for human
diagnosis.

## Consequences

**Wins**

- Lossless: `Date.now()` round-trips through JSON unchanged.
- Sorting and comparison are integer ops (`a < b`); no string
  parsing.
- Storage is compact: 8-byte BIGINT vs ~24-char ISO string.
- No timezone ambiguity; epoch ms is UTC by definition.
- Same shape on all drivers (SQLite + Postgres + indexedDB).
- Indexes on time columns are dense integer indexes — fast.

**Costs**

- Humans can't eyeball a number. We mitigate via:
  - `new Date(ms).toISOString()` in error messages,
  - the admin UI always renders with `toLocaleString()`,
  - the operator runbook includes a Bash function `epoch2date`.
- Sub-millisecond precision is unavailable. Acceptable — the
  domain doesn't have <1ms events.
- 32-bit overflow concerns? No. `Number.MAX_SAFE_INTEGER` covers
  through year 287396, and JS numbers are safe-int up to 2^53.

## Alternatives considered

- **ISO 8601 strings**: rejected — string compares for ordering;
  parsing on every comparison; ambiguous with no-tz strings;
  ~3× the storage.
- **Epoch seconds**: rejected — sub-second precision matters for
  some events (rate-limit reset, retry-after header). Promoting
  to ms across the board is one fewer conversion.
- **Driver-typed `Date`**: rejected — splits behaviour across
  drivers; `Date` doesn't survive `JSON.stringify`/`parse` round
  trips losslessly.

## Related

- `src/utils/clock.ts` (Clock interface for testability)
- Every migration file under `src/storage/migrations.ts`
- `packages/contracts/` event payloads
