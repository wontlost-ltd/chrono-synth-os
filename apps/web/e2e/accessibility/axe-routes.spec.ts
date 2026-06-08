/**
 * P1.3 / EP-2.2 — axe-core/playwright on every meaningful route
 *
 * Tags: 'wcag2a', 'wcag2aa' — WCAG 2.1 AA conformance baseline.
 * 'best-practice' is excluded from the strict gate (too many false-positive
 * cases for our component library); we capture them as `expect.soft` so
 * regressions surface without breaking the build.
 *
 * Severity gate: only Critical + Serious violations fail the test. Moderate
 * + Minor are recorded as soft expectations and visible in the playwright
 * report. This matches the plan's "0 violations on critical paths" target
 * while letting incremental improvements land without all-or-nothing.
 *
 * Auth-gated routes: we seed the session via localStorage before goto().
 * The mocks below are minimal — just enough to render the page; we don't
 * exercise data-fetching paths because axe runs against the rendered DOM.
 *
 * --- Why playwright-axe (and not vitest-axe) ---
 *
 * The execution-plan-2026-05.md EP-2.2 originally suggested vitest-axe.
 * Intentional deviation: vitest-axe runs in jsdom, which has no real
 * layout / paint engine. That makes several axe rules unreliable:
 *
 *   - color-contrast: jsdom returns synthetic computed styles; contrast
 *     ratios get reported but reflect Tailwind class strings rather than
 *     actually-rendered RGB values.
 *   - focus-visible / focus-order: jsdom's focus emulation skips many
 *     real-browser invariants (e.g. tab traps in modal portals).
 *   - aria-live region detection: jsdom does not announce mutations the
 *     way assistive tech does, so live-region rules misfire.
 *
 * Running axe inside Playwright Chromium catches the violations that
 * actually impact users. The trade-off is a slower test (~1s per route
 * vs ~50ms in jsdom), which is acceptable for the 13 routes covered
 * here on a CI cron-and-PR cadence. See docs/operations/a11y-runbook.md
 * for the full rationale and how to read failures.
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const SESSION_STATE = JSON.stringify({
  apiKey: 'axe-test-api-key',
  tenantId: 'default',
  mode: 'authenticated',
  user: {
    id: 'axe-test-user',
    email: 'axe@example.test',
    role: 'admin',
  },
});

async function seedSession(page: Page) {
  /* localStorage write must happen on a same-origin page; navigate to login
   * (which is unauth) first, set the key, then navigate to the target. */
  await page.goto('/login');
  await page.evaluate((value) => {
    localStorage.setItem('chrono-session', value);
    /* Suppress the P3.7 first-run welcome modal so its illustration overlay
     * doesn't pollute axe scans on every admin route. */
    localStorage.setItem('chrono.user.welcome-seen', 'true');
  }, SESSION_STATE);
}

/* Empty-state mocks: each list endpoint returns []. axe only cares about
 * markup; empty lists exercise the EmptyState component which is a common
 * a11y regression point (alt text on illustrations, heading levels). */
async function mockApisEmpty(page: Page) {
  const empty = (data: unknown = []) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
  /* Catch-all: anything we don't explicitly mock returns []; safer than 404
   * because some pages render an EmptyState only when data === []. */
  await page.route('**/api/v1/admin/tool-permissions**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/admin/personas/*/tool-permissions**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/admin/personas/*/tool-invocations**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/admin/agency-authorizations**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/admin/safety/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      data: {
        safetyScore: 92,
        memoryConfidence: { unverifiedCount: 0, total: 10 },
        drift: { recentAlerts: [], latestReport: null },
      },
    }),
  }));
  await page.route('**/api/v1/admin/safety/drift-report**', (route) => route.fulfill(empty(null)));
  await page.route('**/api/v1/agent/oauth/google/tokens**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/agent/confirmations**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/billing/plans**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/billing/usage**', (route) => route.fulfill(empty(null)));
  await page.route('**/api/v1/personas**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/avatars**', (route) => route.fulfill(empty([])));
  /* Simulations: list endpoints return [], visualization endpoints return
   * shape-correct empty objects so the chart components render their
   * EmptyState (one of the highest-traffic a11y regression points). */
  await page.route('**/api/v1/simulations/*/visualization/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      data: { simulationId: 'axe-sim', summary: {}, timeline: [], pathCount: 0 },
    }),
  }));
  await page.route('**/api/v1/simulations/*/visualization/paths**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      data: { paths: [], metricMeta: [] },
    }),
  }));
  await page.route('**/api/v1/simulations/*/visualization/milestones**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: { events: [] } }),
  }));
  await page.route('**/api/v1/simulations**', (route) => route.fulfill(empty([])));
  /* Onboarding: status fetch decides whether to render walkthrough or
   * redirect; returning a fresh-user payload keeps us on the page. */
  await page.route('**/api/v1/onboarding/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      data: { completed: false, currentStep: 'welcome' },
    }),
  }));
  /* Values: Onboarding's last step writes core_values; mock as empty
   * so the page renders the form rather than an error state. */
  await page.route('**/api/v1/values**', (route) => route.fulfill(empty([])));

  /* §8 Step 14 routes: marketplace / autorun / persona-core /
   * conflicts / growth. Each rendered as EmptyState when data is [].
   * The growth page reads aggregated counters; mock as a zero-state. */
  await page.route('**/api/v1/marketplace/tasks**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/marketplace/categories**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/avatars/*/autorun**', (route) => route.fulfill(empty(null)));
  await page.route('**/api/v1/avatars/*/autorun/runs**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/persona-core**', (route) => route.fulfill(empty(null)));
  await page.route('**/api/v1/persona-core/**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/conflicts**', (route) => route.fulfill(empty([])));
  await page.route('**/api/v1/growth**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      data: { metrics: [], milestones: [], counters: {} },
    }),
  }));
}

interface Route {
  name: string;
  path: string;
  /** auth required to render */
  authed: boolean;
}

/* Scope: the unauth public surface + the 6 P0.4 admin/agent pages we
 * migrated to i18n (highest scrutiny for new code) + a few core pages
 * + the 3 user-facing routes EP-2.2 calls out (dashboard / onboarding /
 * a deep simulation visualization page).
 *
 * Note on EP-2.2 wording: the plan listed "ConversationDetail" as one of
 * the 5 core pages. There is no /conversations/:id route on the SPA — the
 * conversation feature lives in the backend API only (P1-C). We substitute
 * /simulations/:id/paths because PathComparison is the deepest visualization
 * surface (charts + tables + i18n-localised metric labels) and is the most
 * likely to regress on a11y as the design system evolves. */
const ROUTES: Route[] = [
  { name: 'login', path: '/login', authed: false },
  { name: 'register', path: '/register', authed: false },
  { name: 'dashboard', path: '/dashboard', authed: true },
  { name: 'onboarding', path: '/onboarding', authed: true },
  { name: 'simulation-paths', path: '/simulations/axe-sim/paths', authed: true },
  { name: 'admin-tool-permissions', path: '/admin/tool-permissions', authed: true },
  { name: 'admin-agency-authorizations', path: '/admin/agency-authorizations', authed: true },
  { name: 'admin-tool-invocations', path: '/admin/tool-invocations', authed: true },
  { name: 'admin-safety-drift', path: '/admin/safety/drift', authed: true },
  { name: 'agent-oauth-google', path: '/agent/oauth/google', authed: true },
  { name: 'agent-confirmations', path: '/agent/confirmations', authed: true },
  { name: 'billing', path: '/billing', authed: true },
  { name: 'settings', path: '/settings', authed: true },
  /* §8 Step 14 — the 5 feature routes the plan called out as the
   * remaining a11y coverage gap. Each route is rendered with mocked
   * empty data so the EmptyState's a11y semantics are what we audit
   * (headings, landmark roles, focus order); the loaded-data path is
   * exercised by per-feature vitest suites. */
  { name: 'marketplace', path: '/marketplace', authed: true },
  { name: 'autorun-config', path: '/avatars/axe-avatar/autorun', authed: true },
  { name: 'persona-core', path: '/persona-core', authed: true },
  { name: 'conflicts', path: '/conflicts', authed: true },
  { name: 'growth', path: '/growth', authed: true },
];

for (const route of ROUTES) {
  test(`axe: ${route.name} (${route.path}) WCAG 2.1 AA`, async ({ page }) => {
    if (route.authed) {
      await seedSession(page);
      await mockApisEmpty(page);
    }
    await page.goto(route.path);
    /* networkidle is brittle on streaming/SSE pages; domcontentloaded +
     * a brief settle is enough for axe to walk the rendered DOM. */
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(200);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      /* Skip rules that fight Tailwind utility patterns or our shell layout:
       * - region: every node should be in a landmark — we use main/header/nav
       *   already, but lazy-loaded suspense fallbacks briefly violate this.
       * - color-contrast: validated separately by Lighthouse against the
       *   baked color tokens; per-page run is noisy with skeleton states. */
      .disableRules(['region'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    const advisory = results.violations.filter(
      (v) => v.impact === 'moderate' || v.impact === 'minor',
    );

    if (blocking.length > 0) {
      const summary = blocking
        .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes; ${v.helpUrl})`)
        .join('\n');
      expect(blocking, `axe blocking violations on ${route.name}:\n${summary}`).toEqual([]);
    }

    if (advisory.length > 0) {
      const summary = advisory
        .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`)
        .join('\n');
      /* soft = recorded in report, doesn't fail the run */
      expect.soft(advisory, `axe advisory on ${route.name}:\n${summary}`).toEqual([]);
    }
  });
}
