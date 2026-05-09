# 0035 — Knowledge bulk import dedupes via SHA-256 content fingerprint (truncated to 128 bits)

**Status:** Accepted
**Date:** 2026-Q2 (P1-B bulk knowledge import)
**Scope:** `src/knowledge/sources/*.ts`, `src/knowledge/knowledge-ingestion-service.ts`

## Context

Phase 1-B shipped bulk knowledge import: an admin can paste hundreds
of FAQ rows / URLs / files in one request and the worker materialises
them as memory_nodes. Re-running the same source must not duplicate
content (e.g. an RSS feed that includes the same article in two
fetches; a CSV uploaded twice with one row corrected).

Each `KnowledgeItem` therefore carries a `fingerprint: string` field
that the ingestion service uses to dedupe. We had to choose:

1. What hash function?
2. What input bytes?
3. How wide?
4. Where to store the index?

## Decision

**SHA-256 of the canonical content text, hex-encoded, truncated to
the first 32 hex characters (= 128 bits)**.

Implementation lives consistently across all five `KnowledgeSource`
implementations (`file-source`, `api-source`, `manual-source`,
`llm-source`, `rss-source`):

```ts
import { createHash } from 'node:crypto';
const fingerprint = createHash('sha256').update(content).digest('hex').slice(0, 32);
```

For `rss-source` only, the input is `raw.link || content` because the
link is the more stable identity for syndicated articles (the same
article reposted with edited content stays the same item).

Dedupe happens in `knowledge-ingestion-service.ts` via a `Set<fingerprint>`
within a single ingest run. Cross-run dedupe falls out of the database
unique index on `(tenant_id, fingerprint)` in the `memory_embeddings`
table.

## Consequences

**Wins**

- 128-bit truncated SHA-256 has a collision probability of ~10⁻¹⁹ at
  10⁹ items. Negligible for any plausible single-tenant scale.
- SHA-256 is in `node:crypto` already; no new dependency.
- 32-hex-char fingerprint = 32 bytes UTF-8 = comfortable for
  PostgreSQL btree indexes (≤256 byte page key limit untouched).
- Identical content from different sources (e.g. file upload of an
  article, then RSS pulling the same URL) collapses to one memory
  with two source links — desired behaviour for "knowledge consolidation".
- Cross-language reproducible: a Python or Go reimporter can compute
  the same fingerprint and de-dupe against existing rows.

**Costs**

- Truncation means we can't reverse fingerprint → content. Acceptable
  because we never need to.
- Different `KnowledgeSource` implementations use slightly different
  input bytes (rss uses link, others use content). A user who
  uploads an article via file-source and later subscribes to an RSS
  with that same article will see two distinct memories. We accept
  this; the inputs are genuinely different identities.
- A whitespace edit creates a new fingerprint. We don't normalise
  (collapse whitespace, lowercase) before hashing because:
    - LLM context recall is sensitive to whitespace/case
    - "Slightly edited document" is often a meaningful new version,
      not a duplicate
    - Adding a normalisation step is reversible (we can pre-process
      content in a future migration); removing it is not.

## Alternatives considered

- **MD5 (or SHA-1) instead of SHA-256:** rejected. CPU cost difference
  is invisible at our throughput. SHA-256 is the conservative pick
  for any "this represents user data" use, and FIPS deployments
  forbid MD5 / SHA-1.
- **Full 64-char SHA-256:** rejected for storage cost only. 32 bytes
  vs 64 bytes per row is negligible per row but adds up over 10M
  rows; the collision probability gain is meaningless.
- **UUID v5 (namespace + name):** rejected. UUID v5 also wraps
  SHA-1 — see above. Plus it loses the "fingerprint = hex of well-
  defined hash function" property that lets external tools verify.
- **Content + metadata (tenant_id, source_id) in the hash:** rejected.
  We *want* cross-source dedupe; that's the point. tenant_id is
  enforced separately at the DB unique index level so cross-tenant
  collisions stay impossible.
- **Compute fingerprint server-side only (don't trust client):** the
  fingerprint *is* computed server-side — the `KnowledgeSource`
  implementations all run in the worker, not the API. The client
  posts raw content; the source implementation hashes it.

## How to enforce going forward

- New `KnowledgeSource` implementations must set `fingerprint` using
  the same `createHash('sha256').update(content).digest('hex').slice(0, 32)`
  pattern. The `KnowledgeSource` interface in `src/knowledge/knowledge-source.ts`
  documents this contract.
- The unique index on `(tenant_id, fingerprint)` in
  `migrations.ts/postgres-migrations.ts` v063/v064 is the safety net
  for any source that forgets to set fingerprint correctly: insertion
  fails loudly rather than silently duplicating.
- Don't change the truncation length without a coordinated migration.
  Existing rows have 32-char fingerprints; mixing 32 and 64 in the
  same table breaks dedupe.

## Related

- [ADR-0011 — `core_values` is tall, tenant-scoped](0011-core-values-tall-schema.md) —
  same tenant_id partitioning pattern
- `src/knowledge/sources/*.ts` — five concrete implementations
- `src/knowledge/knowledge-ingestion-service.ts:73-77` — dedupe loop
- `.claude/plan/done/p1-b-bulk-knowledge-import.md` — feature plan
- Migrations v063 + v064 — bulk import metadata + unique fingerprint index
