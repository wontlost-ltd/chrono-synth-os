# Accessibility (P1.3)

This document captures how Chrono Synth Web meets WCAG 2.1 AA, what's
automated, and what still needs human judgment.

## Conformance target

- **WCAG 2.1 Level AA** — every meaningful route should pass axe with zero
  Critical/Serious violations.
- **Lighthouse Accessibility category ≥ 0.95** on every public page.
- **Keyboard-only operation** — all flows that produce value (login, run a
  simulation, grant a tool permission, approve a confirmation) work without a
  pointing device.
- **Screen reader compatible** — manual checklist on the next release with at
  least one production tester per team using NVDA + VoiceOver.

We treat the automated checks as the floor, not the ceiling. Axe catches ~30%
of WCAG issues; the remaining 70% — heading hierarchy, focus management
during dynamic content, plain-language copy — comes from review.

## Automation

| Layer | Tool | Trigger | Gate |
|-------|------|---------|------|
| Per-route DOM | `@axe-core/playwright` in `e2e/accessibility/axe-routes.spec.ts` | every PR + push | Critical/Serious = fail; Moderate/Minor = soft fail (visible in report) |
| Keyboard nav | Playwright in `e2e/accessibility/keyboard-nav.spec.ts` | every PR + push | hard fail |
| Lighthouse | `lhci autorun` (`.lighthouserc.js`) | nightly + manual | accessibility category < 0.95 = fail |
| Color contrast | Lighthouse `color-contrast` rule | nightly | ratio < 4.5:1 = fail (3:1 for large text) |

The Lighthouse run currently covers `/login` and `/register`; expand to
authenticated routes once test fixtures provision a real user (separate
PR — same machinery, just more URLs and a `puppeteer-extra-plugin-stealth`
seed step).

## Severity rules in the axe job

```
Critical / Serious  → fails the test (blocks merge)
Moderate / Minor    → soft fail (recorded in report, doesn't block)
```

Rules deliberately disabled in the per-route axe run:

- **`region`**: every node should be inside a landmark. Lazy-loaded
  Suspense fallbacks transiently violate this; we cover landmarks in the
  AppShell layout test instead.
- **`color-contrast`**: validated by Lighthouse against the baked-in
  Tailwind tokens. Per-page contrast checks are noisy during skeleton/
  loading states.

If you're adding a route that legitimately needs another rule disabled,
document the reason in the spec file inline and link the relevant axe
rule URL.

## What axe can't catch

These need human review:

1. **Heading hierarchy** — `<h2>` after `<h4>` is invalid but axe doesn't
   gate it. Reviewers verify with Outline view in DevTools.
2. **Form error association** — `aria-describedby` on the input pointing
   to the error span. Test with NVDA: the error text should be read on
   focus.
3. **Live regions for async updates** — a toast announcing "saved" must
   either be in `[aria-live="polite"]` or focus must move to it.
4. **Plain language** — error messages, confirmation copy. Axe doesn't
   read; you do.
5. **Cognitive load** — large forms benefit from grouping with `<fieldset>`
   and `<legend>`.

## How to add a new route

1. Add an entry to `ROUTES` in `e2e/accessibility/axe-routes.spec.ts`.
2. If the route reads data, mock the relevant API in `mockApisEmpty`.
3. Run locally: `npx playwright test e2e/accessibility/`. Fix any
   Critical/Serious findings before merge.
4. If a finding is unavoidable (third-party widget violation), file a
   tracking issue and add a `disableRules([...])` with the issue URL in
   a code comment — never silence without a paper trail.

## Manual screen-reader checklist (per release)

Run on a representative flow (suggested: register → onboarding →
dashboard → run a simulation → review results).

| Check | NVDA | VoiceOver |
|-------|------|-----------|
| Page title announced on load | ☐ | ☐ |
| Each heading announced with level | ☐ | ☐ |
| Form labels announced on focus | ☐ | ☐ |
| Error messages announced when shown | ☐ | ☐ |
| Loading states announced (`aria-busy` or live region) | ☐ | ☐ |
| Modal traps focus and announces title | ☐ | ☐ |
| Toast / live updates announced | ☐ | ☐ |
| Tables read with column headers | ☐ | ☐ |

Record results as a comment on the release PR.

## Design tokens

Color contrast is validated against `src/styles/themes/*.css`. When adding a
new color, run:

```sh
# Quick visual check (any browser):
# https://webaim.org/resources/contrastchecker/
```

Both light and dark themes need ≥4.5:1 for body text, ≥3:1 for large text
(18pt+ or 14pt+ bold).

## Related

- [`.lighthouserc.js`](../.lighthouserc.js) — lighthouse assertions
- [`e2e/accessibility/`](../e2e/accessibility/) — axe + keyboard specs
- [`e2e/a11y.spec.ts`](../e2e/a11y.spec.ts) — earlier focused checks (kept;
  test the form-label edge cases)
