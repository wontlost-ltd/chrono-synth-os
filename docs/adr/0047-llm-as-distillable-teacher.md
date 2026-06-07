# 0047 — The LLM is a distillable teacher, not a runtime dependency

**Status:** Accepted
**Date:** 2026-06-06
**Scope:** `packages/kernel` (intelligence, core-self), `src/intelligence`,
`src/conversation`, `src/meta` (update-gate)
**Relates to:** [0001](0001-kernel-zero-runtime-deps.md) (zero runtime deps),
[0046](0046-dual-product-companion.md) (ChronoCompanion C-end), the
`memory → pattern → value-shift → UpdateGate` chain in
[`src/chrono-synth-os.ts`](../../src/chrono-synth-os.ts).

## Context

ChronoCompanion's value proposition is that the persona — its identity,
memory graph, value weights, and decision style — is a **portable, durable
asset that keeps working without a cloud LLM**. The grown state is the
moat, not prompt-wrapping a model.

Today the codebase contradicts that proposition in its *semantics*, even
though the *substrate* already supports it:

- `@chrono/kernel` is already zero-LLM, zero-I/O, deterministic (ADR-0001).
  A persona's structural reasoning — `structural-scorer`, `rule-engine`
  ("规则引擎（离线决策能力）"), `life-simulation-engine`,
  `emotional-trajectory-engine`, `memory-graph`, `memory-pattern-extractor`
  — runs identically offline.
- But the application layer is wired **LLM-first, rules-as-fallback**.
  `src/intelligence/decision-engine.ts` runs `evaluateWithLLM()` and only
  drops to the rule engine inside a `catch`
  ("LLM 不可用，回退到规则引擎"). The conversation pipeline returns a
  single static apology (`FALLBACK_RESPONSE`) when the LLM is down — a
  service-outage message, not the persona answering from what it has
  learned.

This means an offline persona looks *broken* rather than *autonomous*.
The relationship between the deterministic core and the LLM is inverted
from what the product requires.

A separate forcing function: only **open-ended language** tasks truly
need a model — dialogue generation, free-text understanding, open-ended
alternative generation, natural-language explanation. Everything else
(identity, value weights, memory retrieval, decision scoring,
life-simulation, emotional trajectory, safety constraints) is
deterministic and offline-capable *today*. So the dependency surface on
the LLM is small (~10 call sites, concentrated in `src/intelligence`,
`src/conversation`, `onboarding-v2`).

## Decision

**The deterministic kernel is the runtime substrate. The LLM is a
*teacher* whose outputs are distilled into durable deterministic
artifacts. A grown persona must be able to reason, decide, and converse
with no LLM at all.**

Three consequences are locked by this ADR:

### D1 — Two reasoning modes, deterministic-first

Reasoning is `mode`-aware:

- **Autonomous mode** (offline): deterministic core is the primary and
  only required path. No `LLMProvider` may be *required* to construct or
  run the autonomous runtime.
- **Growth mode** (online): the LLM augments — generating candidates,
  reflections, explanations — but its outputs are *proposals*, never
  direct writes to core state.

The current "LLM-first, rules-in-`catch`" semantics are reversed:
`rule-engine` becomes the primary evaluator in autonomous mode, not a
degraded fallback.

### D2 — "Run without an LLM" means **without a cloud LLM**

Offline dialogue uses a layered, configurable "language skin" over one
deterministic core (founder decision, 2026-06-06):

1. **Pure-local deterministic** *(default)* — template + graph-retrieval
   + slot-fill, zero neural network, reproducible. The mode research and
   privacy users rely on.
2. **Optional local small model** (Ollama / llama.cpp) — *surface
   rewriting only*. Core decisions, facts, and constraints still come
   from deterministic artifacts; the local model is never the source of
   truth and lives in an adapter, never in the kernel.
3. **Optional cloud LLM** — growth-mode teacher only.

A local model is an opt-in language adapter, not a runtime dependency.
The kernel stays zero-LLM (ADR-0001 holds unchanged).

### D3 — LLM output is distilled through a gated pipeline

LLM teaching output is compiled into a `DistilledArtifact` —
`rule | value_shift | memory_edge | decision_style_patch |
cognitive_model_patch | response_template | narrative_patch` — carrying
`confidence`, `evidence` (provenance), and a `status` state machine
(`candidate → approved → compiled → rejected | rolled_back`).

- LLM output **never writes core state directly**. It enters as a
  `candidate`, is schema-validated, gated by the (extended) `UpdateGate`,
  compiled, and snapshotted for rollback.
- The existing `memory → pattern → value-shift → UpdateGate` chain is the
  prototype: a `value_shift` auto-compiles only when LLM confidence ≥ 0.8
  **and** the deterministic pattern-extractor agrees on direction **and**
  `delta ≤ 0.05`; otherwise it becomes a pending update.
- `UpdateGate` extends from L0/L1 to
  `L0 | L1 | L2 | L3 | Narrative | Rule | Template`.

## Consequences

**Wins**

- The persona is a true asset: it runs, decides, and converses offline;
  it survives the LLM vendor going down, getting more expensive, or
  rate-limiting. This is the ChronoCompanion moat made literal.
- Steady-state cost can be zero (no per-turn API spend); growth is the
  only LLM-billed phase.
- Reproducibility: the same snapshot + input yields stable autonomous
  output (a replay harness becomes possible — valuable for research
  users and for regression tests).
- Marketing hook: *"Train with LLMs. Run without them. Own the persona."*
- ADR-0001 is reinforced, not strained — the kernel was already the
  substrate; we are correcting the application-layer semantics.

**Costs**

- Autonomous dialogue is **strictly weaker** than LLM dialogue. We accept
  graceful degradation: offline answers are persona-grounded and
  retrieval-backed but bounded; unknown open topics are deferred
  ("offline — I can't learn this yet; saved for later") rather than
  hallucinated.
- New machinery: `DistilledArtifact` schema, a distillation/compile step,
  UpdateGate level expansion, and an offline responder. Real surface
  area, real tests.
- Two modes mean two code paths and two sets of expectations to keep
  honest (metrics must distinguish `autonomous_response` from
  `llm_fallback`, or autonomous operation looks like an outage).

## Alternatives considered

- **Keep LLM-first, rules as fallback (status quo):** rejected — it makes
  the autonomous persona look broken and contradicts the product thesis.
  The capability exists; the semantics are wrong.
- **Require a local model (Ollama) for offline:** rejected as the
  *default* — it raises hardware/deploy requirements and reintroduces a
  non-deterministic generator into the core path. Allowed as opt-in layer
  (2) only, never as the source of truth.
- **Distill straight into core stores (no artifact/gate):** rejected —
  unaudited, unversioned, unrollback-able self-modification is how a
  persona silently corrupts. The gate + snapshot is the safety contract.
- **Fully reproduce LLM dialogue deterministically:** rejected as a goal —
  open-ended language generation is the one thing that genuinely needs a
  model. We bound the claim to "reason/decide/converse-within-known-scope
  offline," not "match GPT offline."

## Implementation status (2026-06-06)

D1/D2 phase-1 + the distillation pipeline (D3) are implemented and pass
`test:golden`:

- **Autonomous mode + offline responder** (D1/D2): `DecisionEngine`
  `mode: autonomous|growth` (LLMProvider optional); `OfflineConversationResponder`
  replaces the static fallback, reusing `ValueGuard.literalMatch` + output
  self-check.
- **Distillation pipeline** (D3): `distilled_artifacts` table (DSL v080 SQLite
  / v082 Postgres); `DistilledArtifactStore` (tenant+persona-scoped, optimistic
  concurrency); `ArtifactCompiler` (value_shift → value-store, memory_edge →
  memory-graph, narrative_patch → narrative, response_template → procedural
  memory); `DistillationService` (ingest → validate → `canAutoCompile` gate →
  snapshot → compile → state-machine transition → audit), wired into
  `ChronoSynthOS.distillation`; governance API
  `/api/v1/persona-core/:id/distillation/{candidates,artifacts,:id/approve,:id/reject}`
  (JWT + owner + object-level authz + rate-limited).

**Deferred to follow-up PRs** (intentional, not gaps):

- `UpdateGate` extension to L2/L3 — distillation currently gates via its own
  state machine + `canAutoCompile`; merging with `UpdateGate` is future.
- Compile mutex — DONE, and it is **tenant-global, not per-persona**.
  `compileApproved` rolls back via the global `restoreFromSnapshot` (the snapshot
  captures coreSelf + ALL personas + ALL conflicts), so concurrent compiles for
  *different* personas must also be mutually exclusive — a per-persona lock would
  miss that. It is guarded by a compile lease taken on a tenant-global sentinel
  (`GLOBAL_LEASE_PERSONA_ID`), wrapping the whole snapshot→compile→advance→
  compensate critical section; any concurrent compile in the tenant is deferred
  (returns `lease_busy`, artifact left `approved`) and retried by calling
  `approve()` again once the lock frees. Shared mechanism with ADR-0048's
  *per-persona* earning lease: `persona_leases` (DSL v081 / Postgres v083) +
  `PersonaLeaseStore` (compare-and-set, TTL takeover, holder-token isolation),
  injected as an optional `leaseStore` (absent ⇒ single-process synchronous
  semantics, backward compatible). TTL is sound only while the critical section
  ≪ TTL; compile runs fully synchronously, so this holds with wide margin.
- `response_template` dedicated template store — DONE. Previously compiled into
  a `procedural` memory, which decays and is evicted (kindFactor 0.3 decay,
  salience-floor + capacity eviction) — "learned then forgotten", violating the
  distillation persistence guarantee. Now `ArtifactCompiler` writes
  `response_template` into a dedicated, **non-decaying, versioned**
  `response_templates` table (DSL v082 / Postgres v084; composite PK
  `(tenant_id, persona_id, intent, version)` keeps history) via
  `ResponseTemplateStore` (`upsert` appends `maxVersion+1`, `getLatestByIntent`
  is the future conversation-consumer contract entry). Version computation is
  race-free because compile runs under the tenant-global compile lease.
  Note: a **producer** (a distiller that emits `response_template` candidates)
  and a **consumer** (conversation lookup by intent) are still future — this
  lands the durable persistence substrate ahead of them (deliberate, per owner).
- Local Ollama layer-2 adapter (D2 layer 2); Companion dual-mode UX.

## Related

- [0001 — Kernel has zero runtime dependencies](0001-kernel-zero-runtime-deps.md)
- [0046 — Dual-product split: Enterprise + ChronoCompanion](0046-dual-product-companion.md)
- `src/intelligence/rule-engine.ts`, `src/intelligence/decision-engine.ts`
- `src/conversation/conversation-service.ts` (`FALLBACK_RESPONSE`)
- `src/meta/update-gate.ts` (L0/L1 → multi-layer extension)
