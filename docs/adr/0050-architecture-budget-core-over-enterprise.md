# 0050 — Architecture budget: core-persona progress gates new enterprise surface

**Status:** Accepted (D2 amended / D3 withdrawn 2026-06-11 — see correction)
**Date:** 2026-06-11
**Scope:** governance (applies to `src/` enterprise vs core logic,
contribution review); no runtime code.
**Relates to:** [0001](0001-kernel-zero-runtime-deps.md) (kernel zero-deps),
[0046](0046-dual-product-companion.md) (dual-product split),
[0047](0047-llm-as-distillable-teacher.md) (distillable teacher),
[0048](0048-autonomous-earning-loop-governance.md) (earning loop).

## Context

The project's thesis is a **distillable, deterministic, self-growing
persona** (ADR-0047). The self-evolution-loop hardening work (WP-0..WP-3:
earn→distill auto-wiring, the 6/7-kind artifact compiler, the learning
benchmark, real-shape fuzz/contract tests) closed the loop and gave it
hard metrics. With the core proposition now *demonstrably* real, the
remaining structural risk is **occupancy mismatch**: engineering effort
keeps flowing to enterprise SaaS surface faster than to the persona
life-cycle that is the product's reason to exist.

This is not speculation — it is measured. Counting non-test TypeScript
lines on `main` at this ADR's date:

| Area | LOC | Note |
|------|-----|------|
| `src/server` (HTTP / SaaS surface) | 14,857 | largest single area |
| `src/storage` | 9,375 | persistence |
| `packages/kernel/src` (total) | 15,908 | the "pure" core package |
| `src/intelligence` (decision / distillation) | 2,990 | core proposition |
| `src/core` (rhythm layer) | 1,069 | core proposition |

And **inside the kernel domain itself** (`packages/kernel/src/domain`,
15,582 LOC) — the package that ADR-0001 keeps zero-runtime-dependency and
that is supposed to *be* the deterministic persona:

| Kernel-domain subset | LOC | Share of kernel domain |
|----------------------|-----|------------------------|
| core-persona (`core-self`, `persona`, `intelligence`, `conversation`, `identity`) | 9,505 | ~61% |
| enterprise subtrees (`billing`, `enterprise`, `compliance`, `multi-tenant`) | 2,056 | ~13% |

> **Correction (2026-06-11, amends D2/D3 below).** The original framing of
> this 2,056 LOC as "SaaS logic that has nothing to do with the persona"
> was a **measurement error** found while attempting the D3 extraction.
> Those four kernel-domain subtrees contain **only `*-queries.ts` files
> plus re-export-only `index.ts` barrels** — pure Query/Command *kind
> contracts* (zero `class`/`if`/`for`, zero non-relative imports, fully
> ADR-0001 zero-dependency; the only import is `../../ports/query.js`
> types). They are part of **58 such `*-queries.ts` contract files** that
> are the kernel's *universal* pattern: every domain (core-self, identity,
> billing, conversation, …) declares its data-plane contract shapes in the
> kernel while the **executors/services live in `src/`**. So this 2,056 LOC
> is not misplaced SaaS logic — it is exactly what the kernel is designed
> to hold (portable contracts for desktop/edge runtimes). There is no logic
> here to extract; extracting it would *contradict* the kernel's
> contract-layer architecture.
>
> The real occupancy signal is **logic LOC in `src/`**, re-measured
> (Codex-verified): enterprise logic — directories `src/billing` 1,940 +
> `src/enterprise` 2,284 + `src/multi-tenant` 708 + `src/compliance` 674
> (= 5,606) **plus** the matching `src/storage/executors` (billing 689 +
> enterprise 769 + compliance/multi-tenant 171 = 1,629) ≈ **7,235** — vs
> core-persona logic (`src/intelligence` 2,990 + `src/core` 1,069 +
> `src/meta` 561 + `src/accelerated` 294 ≈ **4,914**). The mismatch the
> budget targets is **real but lives in `src/` logic**, not in kernel
> contracts.

The point is **not** that enterprise capability is wrong — ADR-0046
deliberately keeps a dual product (Enterprise governance + ChronoCompanion).
The point is that without a budget, the enterprise surface grows by
default and the persona core grows only when someone makes time for it.

## Decision

Adopt an **architecture budget** as a contribution-review convention
(a documented rule, **not** a hard CI gate — we do not want to block
shipping; we want to make the trade-off visible and deliberate).

### D1 — Core-progress budget rule

> A PR that adds **net new enterprise/SaaS surface** (new endpoints,
> billing/compliance/tenancy logic, admin tooling) should carry, in the
> same PR or an explicitly linked follow-up, **equal-or-greater progress
> on the core-persona proposition** — the self-evolution loop, the
> deterministic decision/distillation path, or its metrics/tests.

"Equal-or-greater" is a judgement call made by the reviewer, not a line
count. The mechanism is a **PR checklist item** the author fills in:

```
## Architecture budget (ADR-0050)
- [ ] This PR adds net enterprise/SaaS surface — if checked, link the
      paired core-persona progress: <PR/issue/commit or "n/a — pure core PR">
```

A pure-core or pure-infra PR checks "n/a" and moves on. Only net-new
enterprise surface owes a paired core contribution.

### D2 — Kernel domain holds the persona **and portable contracts**; not SaaS *logic* (amended 2026-06-11)

`packages/kernel/src/domain` holds two legitimate things: (1) the
**deterministic persona**, and (2) **portable Query/Command *kind
contracts*** (`*-queries.ts`) for *every* domain — including enterprise
ones — so the data-plane shape is reusable across desktop/edge runtimes
that lack the Node server (ADR-0001 zero-dependency). The existing
`billing`/`enterprise`/`compliance`/`multi-tenant` subtrees are exactly
this: pure contracts, correctly placed. They are **not** debt and are
**not** extraction candidates (the original D2/D3 claim was the measurement
error corrected above).

What **must not** enter the kernel domain is **enterprise *logic* with
runtime dependencies** — services, stores, executors, anything with
branching business rules or infra imports. That belongs in `src/` (which
is already where all of it lives). The line is **contract vs.
implementation**, not **persona vs. enterprise**.

### D3 — (withdrawn) — no kernel extraction; the budget watches `src/` logic instead

The original D3 ("opportunistically extract the kernel enterprise subtrees")
is **withdrawn**: there is no logic in those subtrees to extract — they are
contracts (D2). Forcing them out would break the kernel's contract-layer
pattern and diverge them from the other contract files (58 total).

The architecture budget (D1) stands, retargeted at its real subject:
**enterprise *logic* in `src/`** (~7,235 LOC) outweighs **core-persona
logic in `src/`** (~4,914 LOC). New net enterprise *logic* (not contracts)
owes a paired core-persona contribution. The optional non-blocking trend
report (below) should track `src/` enterprise-logic vs core-logic LOC, not
kernel-contract LOC.

## Consequences

**Wins**

- The occupancy mismatch becomes **visible per-PR** instead of
  discovered quarterly. Reviewers can see "this adds enterprise surface
  with no core counterpart" and ask for the pairing.
- The kernel domain stays contracts-only for enterprise concerns — D2
  (amended) blocks enterprise *logic* (services/executors/infra) from
  entering the kernel, while keeping portable contracts where they belong.
- No engineering is blocked: the rule is a checklist + reviewer
  judgement, not a gate. Pure-core and infra work pay nothing.
- No risky migration: D3 is withdrawn (the kernel subtrees are contracts,
  not extractable logic), so the budget needs no refactor sprint at all —
  it is purely a per-PR review convention over `src/` logic.

**Costs / risks**

- Judgement-based rules can be rubber-stamped. Mitigation: the checklist
  makes a skipped pairing an explicit, reviewable choice rather than a
  silent omission.
- "Net new enterprise surface" has a fuzzy boundary. Accepted: the rule
  optimises for making the conversation happen, not for precise
  accounting; a borderline PR simply triggers a one-line reviewer note.
- The `src/` enterprise-logic vs core-logic mismatch persists until
  weighed per-PR via D1. Accepted as the deliberately light intervention
  over a heavy process. (The original "kernel-domain debt" framing is
  withdrawn — see the 2026-06-11 correction; those kernel subtrees are
  contracts, not debt.)

**Registered follow-up (non-blocking):** to lower the rubber-stamp risk
of a judgement-only checklist, a future **non-blocking** trend report may
emit (on PR or on a schedule) the **`src/` enterprise-logic vs
core-persona-logic LOC** trend (not kernel-contract LOC — see correction)
— comment only, never a red light. This stays a reporting aid, not a gate
(a gate is explicitly rejected above).

## Alternatives considered

- **Hard CI gate (block PRs that add enterprise LOC without core LOC):**
  rejected — LOC is a bad proxy for value, and a gate would block
  legitimate enterprise work (Enterprise GA must not be blocked, ADR-0046).
  We want visibility, not obstruction.
- **Big-bang kernel cleanup now:** rejected — *and the premise turned out
  false*: there is no enterprise *logic* in the kernel to clean up (the
  subtrees are contracts, per the 2026-06-11 correction). Attempting D3
  surfaced the measurement error; the honest outcome is to withdraw the
  extraction, not perform it.
- **Do nothing (status quo):** rejected — the re-measured mismatch
  (`src/` enterprise logic ~7,235 LOC vs core-persona logic ~4,914 LOC,
  and `src/server` being the single largest area) shows the default
  trajectory drifts toward enterprise surface. A budget is the minimum
  intervention that corrects the trajectory without a heavy process.

## Related

- [0001 — kernel zero runtime deps](0001-kernel-zero-runtime-deps.md) —
  the invariant D2 protects; enterprise concerns in the kernel pressure it.
- [0046 — dual-product split](0046-dual-product-companion.md) —
  enterprise capability is intentional; the budget governs its *pace*,
  not its existence; Enterprise GA must not be blocked.
- [0047 — LLM as distillable teacher](0047-llm-as-distillable-teacher.md) —
  the core-persona proposition the budget protects engineering time for.
- `docs/plan/self-evolution-loop-hardening-wbs.md` — WP-4 originates this
  ADR; baseline numbers re-measured here on `main`.
