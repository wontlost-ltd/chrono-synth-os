# Persona Portable Format (PPF) — v1 Specification

**Status:** Draft 1 (2026-05-05)
**Editors:** Chrono Synth project
**Audience:** Implementers of ChronoSynth-compatible runtimes and migration tooling

---

## 1. Purpose

PPF is the on-the-wire format for moving a digital persona — values, narrative, memory graph, governance settings — between two ChronoSynth-compatible instances. It is the contract that turns "export your data" from a ChronoSynth-specific feature into a portable user right.

PPF v1 covers:

- **Identity** — DID-style persona ID + version
- **Core self** — values, narrative, decision style, anchors, cognitive model
- **Memory** — memory nodes with confidence + source-kind
- **Capabilities & tools** — what the persona is allowed to do, and where
- **Governance** — drift thresholds, hallucination policy, retention
- **Provenance** — source instance, export time, signing

PPF v1 does **not** cover:

- Active runtime state (live conversation sessions, in-flight tool invocations)
- Billing relationships (each instance owns its own commercial state)
- Encryption-at-rest envelopes (those are an instance-local concern)

## 2. Document type

A PPF document is a JSON object using JSON-LD framing. The document MUST contain `@context` and `@type`:

```json
{
  "@context": "https://chrono-synth.dev/ppf/v1",
  "@type": "PersonaKernel",
  "id": "did:chrono:abc123",
  "version": "1.0",
  ...
}
```

`@context` is the canonical URL for the v1 vocabulary. Implementations MAY cache it; producers MUST still emit the URL literally.

## 3. Top-level fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `@context` | string | yes | Exactly `https://chrono-synth.dev/ppf/v1` |
| `@type` | string | yes | Exactly `PersonaKernel` |
| `id` | string | yes | DID-style identifier; format `did:chrono:<base32>` |
| `version` | string | yes | PPF version, MUST be `"1.0"` for v1 |
| `createdAt` | integer (ms epoch) | yes | When the source persona was originally created |
| `exportedAt` | integer (ms epoch) | yes | When this PPF document was produced |
| `sourceInstance` | string | yes | URL or DID of the producing instance, e.g. `https://app.chrono-synth.dev` |
| `values` | array | yes | See §4 |
| `narrative` | object | yes | See §5 |
| `memory` | object | yes | See §6 |
| `capabilities` | array of strings | yes | See §7 |
| `tools` | object | yes | See §7 |
| `governance` | object | yes | See §8 |
| `provenance` | object | yes | See §9 |
| `signature` | object \| null | optional | See §10 |

Producers MAY include additional top-level fields prefixed with `x-`. Consumers MUST ignore unknown fields.

## 4. `values`

Each value is the weighted preference / principle that anchors the persona's responses. The order MUST be sorted by `weight` descending, then `id` ascending, to make documents byte-stable for hashing.

```json
"values": [
  { "id": "patience", "label": "Patience", "weight": 0.92 },
  { "id": "precision", "label": "Precision", "weight": 0.78 }
]
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | URL-safe; recommended kebab-case |
| `label` | string | yes | Human-readable; UTF-8 |
| `weight` | number | yes | `0.0 ≤ weight ≤ 1.0`, fixed-point with 4 decimals |

## 5. `narrative`

The persona's first-person identity narrative, plus optional secondary narratives.

```json
"narrative": {
  "primary": "I am a patient assistant who values precision over speed.",
  "additional": []
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `primary` | string | yes | Max 4096 UTF-8 chars |
| `additional` | array of strings | no | Each entry max 1024 chars |

## 6. `memory`

The serialized memory graph.

```json
"memory": {
  "schema": "memory-node.v1",
  "nodes": [
    {
      "id": "mem_abc",
      "kind": "fact",
      "summary": "User prefers Markdown over rich text.",
      "confidenceScore": 0.95,
      "unverified": false,
      "sourceKind": "user_input",
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "tenantScope": "default"
    }
  ],
  "edges": [
    { "from": "mem_abc", "to": "mem_xyz", "relation": "supports", "weight": 0.6 }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `schema` | string | yes | MUST be `memory-node.v1` for PPF v1 |
| `nodes` | array | yes | Sorted by `createdAt` ascending |
| `edges` | array | yes | May be empty |

### Memory node fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | Stable across exports |
| `kind` | string | yes | One of `fact`, `event`, `belief`, `relationship`, `goal` |
| `summary` | string | yes | Max 1024 chars |
| `confidenceScore` | number | yes | `0.0–1.0` |
| `unverified` | boolean | yes | True when `confidenceScore < 0.4` or `sourceKind = unknown` |
| `sourceKind` | string | yes | One of `user_input`, `system_inferred`, `api_sync`, `unknown` |
| `createdAt` | integer | yes | ms epoch |
| `updatedAt` | integer | yes | ms epoch |
| `tenantScope` | string | yes | Source tenant id; receivers map to their own tenant on import |

## 7. `capabilities` and `tools`

Capabilities are coarse-grained intent grants. Tools are fine-grained allow/deny lists.

```json
"capabilities": ["conversation", "knowledge_retrieval", "calendar_read"],
"tools": {
  "allowed": ["web_search", "calendar.read"],
  "denied": ["payment.*", "email.send"]
}
```

| Capability tokens (v1) | Meaning |
|------------------------|---------|
| `conversation` | Persona may participate in interactive chat |
| `knowledge_retrieval` | Persona may call internal knowledge tools |
| `calendar_read` | Persona may read calendar |
| `calendar_write` | Persona may write calendar |
| `email_send` | Persona may send email (high-risk) |
| `web_search` | Persona may issue external web search |

Tool names follow the `<provider>.<verb>` convention. `*` is allowed as a trailing wildcard in `denied`.

## 8. `governance`

```json
"governance": {
  "driftThreshold": { "warning": 0.15, "critical": 0.30 },
  "hallucinationPolicy": "flag_and_confirm",
  "retentionDays": 365,
  "requireConfirmationFor": ["email_send", "calendar_write"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `driftThreshold.warning` | number | yes | `0–1`, MUST satisfy `warning < critical` |
| `driftThreshold.critical` | number | yes | `0–1` |
| `hallucinationPolicy` | string | yes | One of `block`, `flag_and_confirm`, `log_only` |
| `retentionDays` | integer | yes | `≥ 7` |
| `requireConfirmationFor` | array of strings | yes | Tool names; receivers SHOULD honor on import |

## 9. `provenance`

```json
"provenance": {
  "exportedBy": "user_42",
  "exportReason": "user_initiated",
  "checksum": "sha256:0x..."
}
```

`checksum` is the SHA-256 of the *canonical* document with `signature` set to `null`. Producers MUST emit canonical JSON (RFC 8785) before hashing.

## 10. `signature` (optional)

If present, the document was signed by the source instance.

```json
"signature": {
  "alg": "Ed25519",
  "keyId": "did:chrono:source#k1",
  "signedAt": 1700000000000,
  "value": "base64url..."
}
```

The signature covers the canonical bytes of the document with `signature.value` set to `""` (empty string). Consumers SHOULD verify if signature is present; absence does not invalidate the document but downgrades trust.

## 11. Compatibility & versioning

PPF major versions are mutually incompatible. A consumer that does not understand `version` MUST refuse to import. Consumers MAY ignore unknown top-level fields (forward-compat for `1.x` minor versions).

Round-trip property:

> If two compatible v1 instances export the same persona and re-import the resulting documents, the re-imported persona MUST produce a byte-identical PPF document on a subsequent export, modulo `exportedAt`, `provenance.exportedBy`, and `signature`.

This is the test that gates the v1 freeze.

## 12. Out of scope for v1

- Conversation transcripts and live sessions
- Subscriptions, payments, billing relationships
- Encrypted-at-rest envelopes (consumer policy)
- Multi-persona bundles (single-persona-per-document for v1)
- Differential / incremental exports (v1 is full-snapshot only)

These are candidates for v1.1 or v2.

## 13. Conformance test vectors

A reference test corpus lives at `docs/ppf/v1/test-vectors/` (to be populated alongside the kernel `1.0.0` release). Each vector pairs an input persona description with its expected canonical PPF document and SHA-256 checksum.

## 14. References

- JSON-LD 1.1: https://www.w3.org/TR/json-ld11/
- RFC 8785 (JSON Canonicalization Scheme): https://datatracker.ietf.org/doc/html/rfc8785
- W3C DID Core 1.0: https://www.w3.org/TR/did-core/
- Ed25519 (RFC 8032): https://datatracker.ietf.org/doc/html/rfc8032
