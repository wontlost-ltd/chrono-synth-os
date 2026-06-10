# 0050 — Architecture budget: core-persona progress gates new enterprise surface

**Status:** Accepted
**Date:** 2026-06-11
**Scope:** governance (applies to `packages/kernel/src/domain`, `src/server`,
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
| enterprise concerns (`billing`, `enterprise`, `compliance`, `multi-tenant`) | 2,056 | ~13% |

So ~13% of the *zero-dependency persona kernel* is SaaS billing /
enterprise / compliance / tenancy logic that has nothing to do with the
persona's deterministic self. That is a standing mental-load tax on every
person reasoning about the core, and a magnet for "just add it to the
kernel" growth.

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

### D2 — Kernel domain is core-only going forward

`packages/kernel/src/domain` is for the **deterministic persona** only.
**No new enterprise concern** (billing, compliance, multi-tenant,
enterprise admin) may be added to the kernel domain. Such logic belongs
in the application layer (`src/server`, `src/storage`) or a dedicated
package, where it can depend on infrastructure freely without taxing the
zero-dependency core (ADR-0001).

The four existing enterprise subtrees in the kernel domain
(`billing`, `enterprise`, `compliance`, `multi-tenant`, 2,056 LOC) are
**registered debt**, not grandfathered-as-fine. They are candidates for
extraction (D3); until extracted they must not grow.

### D3 — Extraction is opportunistic, not a big-bang migration

We do **not** schedule a disruptive refactor to move 2,056 LOC out of the
kernel now (it would be a large, risky, low-user-value change — exactly
the kind ADR/Linus pragmatism rejects). Instead: **when a kernel-domain
enterprise module is next touched for a feature**, that PR should also
take the opportunity to move it out (or document why it can't yet). The
budget rule (D1) funds this by ensuring core progress keeps pace.

First extraction candidates, smallest-blast-radius first:
`compliance` (92 LOC) and `multi-tenant` (102 LOC), then `enterprise`
(895) and `billing` (967).

## Consequences

**Wins**

- The occupancy mismatch becomes **visible per-PR** instead of
  discovered quarterly. Reviewers can see "this adds enterprise surface
  with no core counterpart" and ask for the pairing.
- The kernel domain stops accreting SaaS logic — D2 caps the debt at
  today's 2,056 LOC and points it downward.
- No engineering is blocked: the rule is a checklist + reviewer
  judgement, not a gate. Pure-core and infra work pay nothing.
- Extraction rides existing feature work (D3), so it never needs its own
  risky migration sprint.

**Costs / risks**

- Judgement-based rules can be rubber-stamped. Mitigation: the checklist
  makes a skipped pairing an explicit, reviewable choice rather than a
  silent omission.
- "Net new enterprise surface" has a fuzzy boundary. Accepted: the rule
  optimises for making the conversation happen, not for precise
  accounting; a borderline PR simply triggers a one-line reviewer note.
- The kernel-domain debt persists until features touch it. Accepted as
  the deliberately pragmatic trade (D3) over a big-bang refactor.

**Registered follow-up (non-blocking):** to lower the rubber-stamp risk
of a judgement-only checklist, a future **non-blocking** trend report may
emit (on PR or on a schedule) the kernel-domain enterprise-subset LOC and
its share, and `src/server` vs core-persona LOC trend — comment only,
never a red light. This stays a reporting aid, not a gate (a gate is
explicitly rejected above).

## Alternatives considered

- **Hard CI gate (block PRs that add enterprise LOC without core LOC):**
  rejected — LOC is a bad proxy for value, and a gate would block
  legitimate enterprise work (Enterprise GA must not be blocked, ADR-0046).
  We want visibility, not obstruction.
- **Big-bang kernel cleanup now:** rejected — high risk, low user value,
  violates "solve real problems, not theoretical purity." The debt is
  registered and bounded (D2) and extracted opportunistically (D3).
- **Do nothing (status quo):** rejected — the measured 13% enterprise
  share of the zero-dependency kernel and the server surface being the
  single largest area show the default trajectory drifts away from the
  product thesis. A budget is the minimum intervention that corrects the
  trajectory without a heavy process.

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
