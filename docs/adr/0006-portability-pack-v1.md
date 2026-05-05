# 0006 — Portability pack v1 (JSON-LD)

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `src/portability/exporter.ts`, `src/portability/importer.ts`

## Context

Users own their personas. GDPR Art. 20 (Right to Data Portability) is the
floor; the product promise is higher — a user must be able to walk away
from our hosted service and bring their persona to a competitor or to a
self-hosted instance with no data loss.

That requires a documented, vendor-neutral export format. Two options:

1. **A custom JSON schema we control** — flexible, easy to evolve, but
   nobody else parses it.
2. **JSON-LD with public vocabulary** — interoperable with the broader
   semantic web tooling, harder to invent ourselves.

## Decision

**Portability pack v1 is JSON-LD using the `https://chronosynth.org/v1/`
context.** A pack is a single `.zip` containing:

- `pack.jsonld` — the persona, value graph, memories, beliefs, audit
  trail, and a `@context` that maps each predicate to a public URI.
- `media/` — referenced binary attachments (avatars, voice notes).
- `signatures.txt` — a detached signature over `pack.jsonld` so the
  receiver can verify the export came from our service.

The vocabulary is published at `chronosynth.org/v1/` and versioned
forward; v2 will be a superset that v1 readers can degrade gracefully.

## Consequences

**Wins**

- Any JSON-LD-aware tool (Apache Jena, rdflib, jsonld.js) can read the
  pack without writing custom code.
- The `@context` is versioned independently of the data — old packs stay
  readable as the vocabulary grows.
- Re-importing a pack into a fresh instance round-trips losslessly; this
  is part of the integration test suite.

**Costs**

- JSON-LD framing/expansion is heavier than a custom schema. We absorb
  the cost on import (one-time) but never at hot-path read time.
- Predicate names in the vocabulary need bikeshedding ("hasValue" vs
  "weighsValue") — every name is committed to forever once shipped.

## Alternatives considered

- **Custom JSON schema:** rejected — even if we publish the schema, only
  our parser implements it. No external tooling.
- **Protobuf with descriptor in the pack:** rejected — too binary; a user
  reading their own export with `cat | jq` is a feature.

## Related

- [0007 — Version-aware commitImport](0007-version-aware-import.md)
- `src/portability/`
