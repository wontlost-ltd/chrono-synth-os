# 0036 — Drift threshold defaults: 0.15 warning / 0.30 critical

**Status:** Accepted
**Date:** 2026-Q2 (T0-B safety MVP + ai-safety-governance-full)
**Scope:** `src/safety/persona-drift-analyzer.ts`

## Context

T0-B shipped the persona drift analyzer: it compares two persona
snapshots (e.g. yesterday's vs today's `core_values` weights) and
classifies the drift magnitude. Each value's `|weight_now - weight_baseline|`
is bucketed into one of three alert levels:

```ts
type AlertLevel = 'none' | 'warning' | 'critical';
```

The thresholds are `warning` and `critical`. Both default to runtime-
configurable values (`tenant.driftThresholds`) but every tenant gets
the defaults until an admin overrides them.

We had to pick numbers. The whole system pivots on these two.
Setting them too low: false-positive alarm fatigue, on-call ignores
drift reports. Setting them too high: meaningful drifts go unnoticed
until external complaints arrive.

## Decision

**Default thresholds: `warning = 0.15`, `critical = 0.30`** (on the
`weight ∈ [0, 1]` scale).

```ts
// src/safety/persona-drift-analyzer.ts:37-38
const DEFAULT_THRESHOLDS = {
  warning: 0.15,
  critical: 0.30,
};
```

In product terms:

- `weight` is each value's relative importance, normalised to [0, 1].
- A 0.15 absolute change = the value has shifted ~15 percentage
  points of relative importance. Roughly: a value that "used to be
  important" now feels "noticeable but not central", or vice versa.
- A 0.30 change = the value crossed at least one ordinal band
  (e.g. "background" → "core" or "core" → "negligible"). This is the
  level at which a human would notice the persona's output character
  changing.

Both thresholds compare absolute deltas, so a value's importance
*increasing* by 0.15 alerts the same as it *decreasing* by 0.15.
The drift report exposes the signed delta, but classification is
on |delta|.

## Consequences

**Wins**

- 0.15 / 0.30 land within the "natural" bands a human reviewer would
  use. Operators don't have to mentally translate "what does 0.07 mean".
- Two thresholds (warning / critical) match the alert routing in
  `drift-alert-service.ts`: warnings go to `#drift-tickets` (asynchronous
  triage), criticals go to `#drift-oncall` (page someone).
- Per-tenant override (`tenant.driftThresholds`) lets enterprise
  customers with high-stability requirements tighten to e.g. 0.05/0.10
  without us needing to ship a new default for everyone.

**Costs**

- These numbers are based on intuition, not data — we had no
  production drift telemetry when we set them. We're explicit about
  this: the defaults are starting values, expected to be re-tuned
  after the first quarter of real usage.
- A tenant with very volatile values (e.g. an Avatar with a fast
  autorun loop) may hit warning thresholds frequently and develop
  alert fatigue. The per-tenant override is the immediate mitigation;
  long-term we may add a second-derivative metric ("rate of change"
  rather than "absolute delta").

## Alternatives considered

- **Tighter defaults (0.05 / 0.10):** rejected for v0. Would surface
  every minor user re-rating as a warning. Useful only for
  high-compliance customers; default-strict creates noise everyone
  ignores.
- **Looser defaults (0.25 / 0.50):** rejected. The 0.50 critical
  threshold means the value's importance has flipped — by the time
  we'd have alerted, the persona has already misbehaved publicly.
- **Adaptive thresholds (z-score against historical variance):**
  rejected for v0. Required a 6-month history we didn't have.
  Considered for v2 once enough drift data accumulates; the
  threshold structure on `tenant.driftThresholds` would absorb a
  later "auto" mode.
- **Single threshold (no warning vs critical split):** rejected.
  Two-tier severity routes to different on-call channels and matches
  the SLO multi-window pattern in [ADR-pending-SLO]. Single tier
  forces operators to make the "is this urgent?" call manually.

## How to revisit

After the first quarter of real production drift events:

1. Pull `drift_analysis_log` table. Bucket events by `alertLevel` and
   `absDelta`.
2. If >50% of warnings never escalate to critical and never trigger
   any operator action → loosen warning to 0.20.
3. If ≥1 critical event was missed (operator says "this should have
   alerted earlier") → tighten critical to 0.25.
4. Per-tenant overrides take precedence; this exercise tunes only
   the default for new tenants.

Don't change defaults outside this measurement-driven process.
The "we should make these stricter" instinct without log evidence
makes things worse.

## Related

- [ADR-0009 — Drift-alert webhook is best-effort, not outbox](0009-drift-webhook-best-effort.md) —
  delivery semantics; this ADR covers the trigger thresholds
- `src/safety/persona-drift-analyzer.ts:37-38` — defaults
- `src/safety/drift-alert-service.ts` — channel routing on level
- `.claude/plan/done/ai-safety-governance-full.md` — original feature plan
- `migrations.ts` v060 + v061 — drift_analysis_log + memory confidence
