# 0048 — Autonomous earning loop & its governance

**Status:** Accepted
**Date:** 2026-06-07
**Scope:** `src/persona-core` (marketplace, wallet), `src/agent` (tools,
authz), `src/intelligence` (earning orchestration, distillation),
`src/identity` (autorun)
**Relates to:** [0046](0046-dual-product-companion.md) (ChronoCompanion),
[0047](0047-llm-as-distillable-teacher.md) (distillation),
[0012](0012-agency-vs-tool-permission.md) (agency vs tool permission),
[0001](0001-kernel-zero-runtime-deps.md).

## Context

The digital persona is autonomous (ADR-0046 ChronoCompanion;
self-growing via ADR-0047). The product framing: **because it is
autonomous, it can work and earn money.** `marketplace` is its **talent
market** (it accepts gigs for pay); `wallet` is its **salary wallet**.
Earnings (payout + growth + reputation + token) feed back into the
persona — earn → grow → earn-better.

The earning loop already exists at the service level and passes tests:
`publishTask → acceptTask/applyTask → assignTask → runtimeSession(PLAN→
EXECUTE→EVALUATE→...) → submitTaskResult → acceptSubmittedTask →
settleTaskPayment`, crediting wallet + growth + reputation + token in one
transaction. But today `accept/complete` are **owner-triggered over
HTTP** — a human acts on the persona's behalf. That is not autonomous
earning.

Two analyses (backend-arch + frontend-trust) converged: the substrate
(marketplace settlement, wallet, the agent tool-invocation pipeline with
its two-layer authorization, the ADR-0047 distillation gate) is strong;
what's missing is the **autonomous nervous system** (discover → decide →
execute → submit) and an **economic-safety policy layer**. They also
surfaced a real pre-existing vuln: the pipeline's documented
`budgetLimitCents` gate was never enforced (fixed as this ADR's
prerequisite).

Autonomous earning is the highest-trust feature in the product: an AI
acting economically on a human's behalf, touching money, reputation, and
external commitments. The design must make the human a **governor**, not
a bystander.

## Decision

Build an **enterprise-grade autonomous earning loop** (no MVP shortcut).
Five decisions are locked:

### D1 — Economic action must be tool-ized & policy-gated

A persona's earning actions (apply / submit / accept-gig) run as
**registered tools through `ToolInvocationPipeline`**, never by calling
the marketplace service directly. They therefore inherit the two-layer
authorization (ADR-0012): `AgencyAuthorization` (the owner's
natural-language consent — "I authorize my persona to work in category
X") + `ToolPermission` (machine brakes: `budgetLimitCents`,
`maxActionsPerDay`, `requireConfirmation`, allow/deny lists, circuit
breaker).

On top of the pipeline, an **`EarningPolicyEngine`** pre-gates every
earning cycle: category allowlist, daily reward exposure cap, max
concurrent open tasks, publisher trust, and AML/abuse guards
(no self-publish-self-accept, no related-account cycling, reject
abnormal-reward/low-quality repeats).

### D2 — Wallet is credit-only for the autonomous flow; debit needs a human

**Hard invariant:** the autonomous flow can only **credit** the wallet
(earn). Any **debit** — withdrawal (`requestWalletPayout`), transfer, or
paying tool costs from the balance — **requires human confirmation**.
Every wallet mutation carries an actor type; a debit attributed to an
`autonomous` actor is rejected outright.

The wallet is abstracted behind a **`WalletLedger` interface**
(`credit` / `debit` / `balance` / `transactions`) implemented over
Postgres today. This preserves the option to back it with a chain ledger
later (see Consequences) without changing earning logic. **We do not put
the wallet on a blockchain now** — see Alternatives.

### D3 — The accept/decide step is deterministic (ADR-0047)

Whether to accept a gig is decided by the **`DecisionEngine` in
autonomous mode** (ADR-0047) — deterministic, no LLM required —
alternatives `accept | skip | needs_human_review`, over deterministic
inputs (reward, risk class, capability match, value alignment,
opportunity cost, reputation impact, current load). A matcher scores
task fit from category, reward, persona capability, reputation, and
history.

### D4 — Task execution is layered (deterministic skill router + optional LLM)

The runtime session's EXECUTE step runs a **deterministic skill router**
as the primary path: it maps a task category to a chain of registered
tools (WebSearch / Knowledge / Memory / Email / …), all through the
pipeline, producing real deliverables. This keeps earning runnable
offline / reproducibly (ADR-0047 layer 1). In growth mode with an LLM
available, the LLM may **enhance** execution quality (ADR-0047 layer 3);
it is never required and never the source of truth.

### D5 — Earnings feed growth only through the distillation gate (ADR-0047)

Task outcomes (payout, quality, reputation, category experience) do not
write core persona state directly. An **`EarningOutcomeDistiller`**
converts them into ADR-0047 distillation **candidates** (`memory_edge`,
`value_shift`, `decision_style_patch`) submitted to
`DistillationService.ingest`. Low-risk high-confidence experience
auto-compiles; high-impact change waits for human approval. This closes
the earn→grow flywheel under the same gate that governs all self-modification.

### Governance matrix (autonomous vs human approval, by risk)

| Risk | Autonomous | Human approval required |
|------|-----------|--------------------------|
| **Low** | known/allowed category, read-only/internal tools, high success rate | — |
| **Medium** | new publisher, higher reward, WebSearch/Knowledge | one-time grant or `needs_human_review` |
| **High** | — | first-time category, Email/Calendar/external commitments, sensitive data, abnormal reward |
| **Critical** | ❌ forbidden | **wallet payout/transfer/debit, suspected AML/wash-trading** |

A **per-persona/per-category circuit breaker** auto-pauses the earning
cycle on consecutive rejections / disputes / reputation collapse.

## Consequences

**Wins**

- A literally autonomous earner: the persona discovers, decides,
  executes, and submits gigs within owner-set boundaries; earnings fund
  its own growth. This is ChronoCompanion's differentiated capability.
- Safety reuses battle-tested rails (agency authz + tool pipeline +
  distillation gate) rather than inventing new ones; the new surface is
  the earning-policy layer and the wallet credit-only invariant.
- Deterministic decision + execution means the loop runs offline and
  reproducibly (ADR-0047), and is auditable.
- The `WalletLedger` abstraction keeps a chain-backed wallet a future
  swap, not a rewrite.

**Costs / risks**

- Real economic risk surface. Mitigated by: tool-ization, earning
  policy, credit-only wallet, human approval for high/critical, circuit
  breakers, full audit.
- **Deployment constraint (hard):** the earning cycle is safe only under a
  **single-process synchronous core writer**. Daily-reward-exposure is
  computed from a 24h window over accepted tasks, which is correct
  single-process but racy across instances. Before any multi-instance
  deployment that runs earning cycles, a **DB-level per-persona earning
  lease** (unique running cycle per persona, compare-and-set) is REQUIRED —
  otherwise two concurrent cycles can both read stale exposure and exceed
  the daily cap. This is in addition to the per-persona compile mutex noted
  in ADR-0047. Not implemented yet; tracked as the gating item for
  multi-instance earning.
- The deterministic skill router covers a bounded set of task
  categories; categories without a router stay human-or-skip until a
  router exists.
- More moving parts (earning service, policy engine, marketplace tool,
  distiller, governance API) — real test surface.

## Alternatives considered

- **Owner-HTTP-only (status quo):** rejected — not autonomous, defeats
  the product thesis.
- **Blockchain-backed wallet now:** rejected for now. It would break the
  single-transaction settlement that atomically credits wallet + growth
  + reputation (on-chain confirmation is async), reintroduce a runtime
  dependency against ADR-0001, and add regulatory uncertainty
  (autonomous AI + crypto wallet). The wallet's semantics here are a
  *salary wallet* the owner already trusts the platform to keep — it
  does not need trust-minimization. Kept as a **future option** via the
  `WalletLedger` interface (`token_balance` already maps to a future
  on-chain token); revisit if cross-platform/Web3 settlement becomes a
  requirement.
- **LLM-driven execution as the primary path:** rejected as primary —
  conflicts with ADR-0047 ("run without an LLM"); kept as optional
  growth-mode enhancement (D4).
- **Autonomous withdrawal:** rejected — both analyses flagged it as the
  highest-risk action; debit is always human-confirmed (D2).
- **Cram earning into `AvatarAutorunService`:** rejected — economic
  action needs independent governance; a separate `persona_earning_cycle`
  task type and `PersonaEarningService` own it.

## Related

- [0046 — Dual-product: Enterprise + ChronoCompanion](0046-dual-product-companion.md)
  — earning is a Companion capability; must not block Enterprise GA.
- [0047 — LLM as distillable teacher](0047-llm-as-distillable-teacher.md)
  — earnings are growth evidence; decision/execution use deterministic mode.
- [0012 — agency vs tool permission](0012-agency-vs-tool-permission.md)
  — the two-layer authorization the earning tools ride on.
- `src/agent/tool-invocation-pipeline.ts` (budget gate, this ADR's prerequisite).
