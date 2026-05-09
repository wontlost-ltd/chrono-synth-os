# PPF v1 — Interop Report

**Status:** v1 freeze candidate (2026-05-10)
**Audience:** Spec maintainers; downstream implementers evaluating PPF.

This report records the second independent PPF v1 implementation,
which is the gating condition for cutting the v1 freeze (per
`.claude/plan/execution-plan-2026-05.md` §EP-4.1 DoD).

## Summary

| Implementation | Language | Path | Status |
|----------------|----------|------|--------|
| Original (insider) | TypeScript / zod | `packages/contracts/src/ppf/v1.ts` | Authoritative |
| Reference (outsider) | Python 3 stdlib | `reference-impls/python/chrono_ppf/` | Round-trips all v1 test vectors |

Both implementations share zero code and run on different runtimes.
Their only shared artifact is the spec at `docs/ppf/v1/spec.md` and the
JSON test vectors under `docs/ppf/v1/test-vectors/`.

## Test vector coverage

| Vector | TS schema | Python schema | Behavior |
|--------|-----------|---------------|----------|
| `minimal-valid.json` | accepts | accepts | Smallest valid document |
| `invalid-values-out-of-order.json` | rejects | rejects | §4 ordering invariant fires |

All 4 conformance assertions per implementation pass.

## Cross-implementation hash pin

The strongest invariant in PPF v1 is the §9 byte-stable checksum: SHA-256
over the RFC 8785 canonical bytes of the document with `signature` set
to `null`. The two implementations independently compute this hash from
the same input bytes and assert byte-equal output:

```
sha256:0x082d2793c3d6366750be45fb0fea7f4129836743cb8bbe9ed813064d967da680
```

This constant is asserted in:

- `src/test/contract/ppf-v1-test-vectors.test.ts::documentChecksum matches the Python reference impl`
- `reference-impls/python/tests/test_vectors.py::test_checksum_matches_typescript_pin`

A change to either canonicalizer fails CI in both suites simultaneously.

## Spec ambiguities surfaced (and resolved)

During the Python implementation pass, the following spec issues were
identified. None blocked v1 — all were resolved without normative spec
changes.

| Issue | Resolution |
|-------|------------|
| §3 says consumers MUST ignore unknown fields, but doesn't say producers MUST NOT emit them. | Reference impls treat `x-`-prefixed unknowns as forward-compat (matches §3 last paragraph) and reject the rest. Spec text is sufficient; no edit needed. |
| §9 RFC 8785 reference is broad — full impl is ~600 LoC. | PPF only emits ASCII keys, finite numbers in [0,1] or non-negative integers, and bounded UTF-8 strings, so a sorted-keys + `JSON.stringify` (TS) / `json.dumps(sort_keys=True)` (Python) subset suffices. Both impls document this restriction inline. |
| §10 `signature.value` regex `[A-Za-z0-9_-]+` does not enforce base64url padding rules. | Confirmed intentional: PPF prefers unpadded base64url. No change. |

## What's not covered by either implementation

Consistent with spec §12 (Out of scope for v1):

- Live conversation state
- Billing / subscription metadata
- Encrypted-at-rest envelopes
- Multi-persona bundles
- Differential / incremental exports

Ed25519 signature *verification* is also unimplemented; both reference
impls accept signature blobs structurally but do not validate
cryptographic correctness. Per spec §10 this is advisory and absence
of a signature does not invalidate a document — verification is a
deployment-time concern, not an interop concern.

## Recommended next steps

1. **Cut `@chrono/contracts@1.0.0` and `@chrono/kernel@1.0.0`** — interop
   is now demonstrated and the spec has not required normative edits.
   Tracked in `.claude/plan/execution-plan-2026-05.md` §EP-4.2.
2. **Optional: third *insider* impl** in Rust (would slot under
   `reference-impls/rust/`) once the desktop crate stabilizes — useful
   for embedded / Tauri contexts but not blocking.
3. **Vector expansion** — add a `signed-valid.json` and a vector with
   non-empty `memory.edges` before tagging v1.0.1.
