# chrono_ppf — Python reference implementation of PPF v1

Pure-stdlib Python reader/writer for the [Persona Portable Format v1
specification](../../docs/ppf/v1/spec.md). Exists as the **EP-4.1 interop
proof**: a deliberately foreign implementation that consumes the same
test vectors as the in-tree TypeScript schema, demonstrating that the
spec is unambiguous enough for an outside ecosystem to implement
without reading any ChronoSynth code.

## Why a separate implementation?

If only the project's own TypeScript validator ever reads PPF documents,
the spec and the validator drift together — any ambiguity in the spec is
silently fixed up by the validator and never surfaces. A second
implementation in a different language with no shared code forces every
under-specified field to manifest as a test failure.

## Layout

```
reference-impls/python/
├── chrono_ppf/
│   ├── __init__.py       # Public API
│   ├── reader.py         # Spec §3-§10 schema + invariants
│   └── canonical.py      # RFC 8785 subset + §9 SHA-256 checksum
├── tests/
│   └── test_vectors.py   # Round-trips docs/ppf/v1/test-vectors/*.json
├── run_tests.sh
└── README.md (this file)
```

## Running

```bash
cd reference-impls/python && ./run_tests.sh
```

Requires Python ≥3.10. No third-party dependencies.

## What's covered

- `@context` / `@type` / `version` / `id` (`did:chrono:<base32>`)
- `values` array — type checks + `(-weight, id)` ordering invariant from §4
- `narrative` — primary required, additional optional with length caps
- `memory` — `memory-node.v1`, node `kind` / `sourceKind` enums, `createdAt` ordering from §6
- `capabilities` — array of bounded strings
- `tools` — strict allowed/denied arrays
- `governance` — `driftThreshold.critical > warning`, retention ≥ 7
- `provenance` — `sha256:0x<hex>` format
- `signature` — optional Ed25519 with base64url value
- Forward compat: `x-`-prefixed fields accepted; other unknown top-level fields rejected

## What's intentionally not covered

- Ed25519 verification (out of scope for v1; see spec §10 — signatures are advisory)
- Encryption-at-rest envelopes (consumer policy, spec §1)
- Differential / incremental documents (v1 is full-snapshot only, spec §12)

## Cross-implementation hash pin

`tests/test_vectors.py::test_checksum_matches_typescript_pin` asserts the
SHA-256 over the canonical bytes of `minimal-valid.json` (with
`signature: null`) equals the same constant asserted in the TypeScript
test at `src/test/contract/ppf-v1-test-vectors.test.ts`. If either
canonicalizer drifts, both test suites fail in lockstep.

The pinned value (current PPF v1 vector set):

```
sha256:0x082d2793c3d6366750be45fb0fea7f4129836743cb8bbe9ed813064d967da680
```

If you intentionally modify the canonical form, update the constant in
**both** test files in the same commit.
