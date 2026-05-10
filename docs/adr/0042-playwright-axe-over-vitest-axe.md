# 0042 — Web a11y testing uses playwright-axe, not vitest-axe

**Status:** Accepted
**Date:** 2026-05 (EP-2.2 a11y CI)
**Scope:** `chrono-synth-web/e2e/accessibility/`

## Context

EP-2.2 of the enterprise-readiness plan called for axe-core a11y
testing of "5 core pages" with WCAG 2.1 AA target and severity-gated
CI failures. The plan's literal text suggested **vitest-axe** in
`src/test/a11y/` — i.e. axe inside vitest jsdom unit tests.

vitest-axe is fast (~50 ms per test) and doesn't need a real browser.
It looks like the cheap right answer.

It is not.

vitest-axe runs in **jsdom**, which has no real layout / paint engine.
Several axe rules misfire under jsdom in ways that produce false
positives, false negatives, or both:

- **color-contrast**: jsdom returns synthetic computed style values
  that reflect Tailwind class strings rather than the actual rendered
  RGB pixels. Reports both contrasts that don't exist (false positive)
  and misses contrasts that do (false negative).
- **focus-visible / focus-order**: jsdom's focus emulation skips
  real-browser invariants. Tab traps inside modal portals, focus
  rings on `:focus-visible`, focus restoration after modal close —
  all behave subtly wrong.
- **aria-live region detection**: jsdom doesn't fire announcements
  the way assistive tech does, so live-region rules misfire.

Running axe inside Playwright Chromium catches what users actually
experience. The trade-off is ~1 s per route vs ~50 ms in jsdom.

## Decision

**Web a11y tests run via `@axe-core/playwright`** in
`e2e/accessibility/axe-routes.spec.ts` (13 routes) plus
`e2e/axe-a11y.spec.ts` (3 legacy routes) and `e2e/a11y.spec.ts`
(label / lang / no-duplicate-id checks) and
`e2e/accessibility/keyboard-nav.spec.ts` (Tab order + focus rings).

The full a11y suite runs as the `a11y` job in
`.github/workflows/e2e.yml` on every PR. WCAG 2.1 AA tags + severity
gate (Critical/Serious hard-fail; Moderate/Minor `expect.soft`).

Total runtime: ~5 s for 13 routes. Acceptable for PR cadence.

## Consequences

**Wins**

- The violations the suite catches are violations users will hit.
  No "ship this fix, but axe says it's broken in jsdom" debate.
- Single tooling stack with the rest of the e2e suite. Same
  Playwright session-seeding helpers, same API mocking pattern.
  Adding a new route for a11y coverage = copy/paste from the
  existing pattern.
- color-contrast actually works. Tailwind tokens that fail contrast
  fail the gate; tokens that pass do too. Lighthouse complementing
  this gives a second opinion.
- Real browser supports `prefers-reduced-motion`, `prefers-color-scheme`,
  high-contrast media queries. We don't currently test these axes
  but the path is there if we want.

**Costs**

- ~5 s per CI run vs ~500 ms hypothetical jsdom runtime. CI runtime
  is bounded by the longer e2e job anyway, so net impact is ~0.
- Playwright + Chromium binaries are heavier in CI cache than
  vitest-jsdom would be. Mitigated: the e2e job already pulls them
  for the broader test suite.
- A test that depends on data-fetching paths needs API mocking
  (route stubs at `**/api/v1/...`). vitest-axe would have skipped
  that because jsdom doesn't fetch. We accept the mocking burden
  because it gives us a real DOM.

## Alternatives considered

- **vitest-axe (the plan's suggestion):** rejected. False
  positives/negatives on color-contrast and focus-* rules make the
  results untrustworthy; we'd waste time triaging non-bugs.
- **vitest-axe + playwright-axe in parallel:** rejected. Two test
  suites with overlapping coverage means double maintenance and
  conflicting failures (jsdom says fail, browser says pass — which
  is right?). Pick one.
- **Pa11y CI (separate tool):** considered. Pa11y also runs in
  Chromium; functionality similar. Rejected because we'd ship a
  second test runner alongside Playwright. One runner, multiple
  spec types.
- **Lighthouse a11y as the primary gate:** Lighthouse is used as a
  *complementary* check (`.lighthouserc.js` enforces minScore 0.95).
  Per-PR axe is faster (~5 s vs ~30 s per Lighthouse run) and gives
  per-rule violations directly; Lighthouse is end-to-end heuristic
  scoring. Both, not either-or.

## How to enforce going forward

- New a11y tests go in `e2e/accessibility/`, not `src/test/a11y/`.
- Severity gate stays at Critical/Serious hard-fail. Moderate/Minor
  use `expect.soft` so they appear in the report without blocking
  PRs. Don't lower the gate without a runbook update + reviewer
  pushback.
- `@axe-core/playwright` is the canonical integration. Don't add
  vitest-axe as "a quick check" — the false-result surface comes back.
- `docs/operations/a11y-runbook.md` documents the rationale +
  triage flow. Re-link from any new a11y-related PR.

## Related

- [ADR-0017 — No Redux/Zustand in adapter-web](0017-no-redux-zustand-in-adapter-web.md) —
  same "pick one tool, document why" instinct
- `chrono-synth-web/docs/operations/a11y-runbook.md`
- `chrono-synth-web/e2e/accessibility/axe-routes.spec.ts` —
  spec docstring also explains this decision
- PR `chrono-synth-web#21` (EP-2.2 a11y route extension)
