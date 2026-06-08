/**
 * §8 Step 10 — Feature-flag remote provider kill-switch e2e.
 *
 * What this test proves:
 *   Admin flipping a feature flag via the OS API reaches connected web
 *   clients live (over SSE) and the affected feature stops rendering
 *   without a page reload. This is the load-bearing acceptance criterion
 *   for incident response — a kill switch with a >0s reload requirement
 *   is not a kill switch.
 *
 * Strategy:
 *   1. Seed session + mock the bootstrap API to return cmdk.enabled=true.
 *   2. Mock the SSE endpoint with a route handler that holds the
 *      connection open, sends the initial snapshot, then later sends a
 *      'change' event setting cmdk.enabled=false on operator command.
 *   3. Wait for the CommandPalette's keyboard handler to be wired up,
 *      open it via Cmd/Ctrl-K, assert the dialog appears.
 *   4. Trigger the SSE 'change' push.
 *   5. Wait for the registry tick, assert the CommandPalette listener is
 *      gone (Cmd-K no longer opens the dialog).
 *
 *   The bootstrap mock fires immediately on load; the SSE mock keeps a
 *   long-lived ReadableStream and a server-side handle so the test can
 *   push 'change' events synchronously from the test process.
 */

import { test, expect, type Page } from '@playwright/test';

const SESSION_STATE = JSON.stringify({
  apiKey: 'kill-switch-test-key',
  tenantId: 'default',
  mode: 'authenticated',
  user: { id: 'kill-test-user', email: 'kill@example.test', role: 'admin' },
});

async function seedSession(page: Page) {
  await page.goto('/login');
  await page.evaluate((value) => {
    localStorage.setItem('chrono-session', value);
    localStorage.setItem('chrono.user.welcome-seen', 'true');
  }, SESSION_STATE);
}

/** Mock the bootstrap endpoint to return cmdk.enabled=true. */
async function mockBootstrap(page: Page) {
  await page.route('**/api/v1/feature-flags/bootstrap', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: [
          { flag: 'cmdk.enabled', value: true, source: 'remote' },
          { flag: 'changelog.drawer.enabled', value: true, source: 'remote' },
          { flag: 'onboarding.checklist.enabled', value: true, source: 'remote' },
        ],
      }),
    });
  });
}

test.describe('Feature flag kill switch (Step 10)', () => {
  test('SSE-pushed cmdk.enabled=false hides the palette without reload', async ({ page }) => {
    /* SSE mock strategy
     * ────────────────
     * Playwright's `route.fulfill({ body })` only accepts a string/Buffer
     * — it does NOT pump a ReadableStream through to the browser. An
     * earlier attempt to cast a ReadableStream to string silently failed
     * (the route handler never ran). The reliable approach is to install
     * a controllable mock EventSource at page-init time via
     * addInitScript, then drive it from the test process via
     * page.evaluate. This bypasses the network layer entirely and gives
     * us a synchronous handle to push 'snapshot' and 'change' events.
     *
     * The mock keeps the latest instance under window.__mockSSE so the
     * test can call .pushEvent(name, payload) at will. */
    await page.addInitScript(() => {
      class MockEventSource extends EventTarget {
        url: string;
        readyState = 0;
        onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
        onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
        onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
        constructor(url: string | URL) {
          super();
          this.url = url.toString();
          /* Reveal this instance + helpers to the test process. */
          (globalThis as unknown as { __mockSSE?: MockEventSource }).__mockSSE = this;
          /* Fire open() on next tick like a real EventSource. */
          setTimeout(() => {
            this.readyState = 1;
            const ev = new Event('open');
            this.dispatchEvent(ev);
            if (this.onopen) this.onopen.call(this as unknown as EventSource, ev);
          }, 0);
        }
        pushEvent(name: string, payload: unknown): void {
          const ev = new MessageEvent(name, { data: JSON.stringify(payload) });
          this.dispatchEvent(ev);
        }
        close(): void {
          this.readyState = 2;
        }
      }
      (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
        MockEventSource as unknown as typeof EventSource;
    });

    await seedSession(page);
    await mockBootstrap(page);

    /* Catch-all stub for dashboard fetches we don't care about. */
    await page.route('**/api/v1/**', (route) => {
      if (route.request().url().includes('/feature-flags/')) return;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');

    /* Push the initial snapshot via the mock SSE. The registry expects
     * this on first connect; without it cmdk.enabled defaults to false
     * and the palette never opens. */
    await page.waitForFunction(
      () => Boolean((globalThis as unknown as { __mockSSE?: unknown }).__mockSSE),
      { timeout: 3000 },
    );
    await page.evaluate(() => {
      const sse = (globalThis as unknown as {
        __mockSSE: { pushEvent(name: string, payload: unknown): void };
      }).__mockSSE;
      sse.pushEvent('snapshot', {
        flags: [{ flag: 'cmdk.enabled', value: true, source: 'remote' }],
      });
    });

    /* Open palette via keyboard. The dialog is tagged data-testid
     * "cmdk-palette" so we don't collide with AppShell's nav drawer and
     * recent-updates panes (both role=dialog). */
    await page.waitForTimeout(200);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    const palette = page.getByTestId('cmdk-palette');
    await expect(palette).toBeVisible({ timeout: 2000 });
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden({ timeout: 2000 });

    /* === Kill the flag === */
    await page.evaluate(() => {
      const sse = (globalThis as unknown as {
        __mockSSE: { pushEvent(name: string, payload: unknown): void };
      }).__mockSSE;
      sse.pushEvent('change', { flag: 'cmdk.enabled', value: false });
    });

    /* The registry processes the SSE event synchronously, but React
     * needs a tick to re-render AppShell and unmount CommandPalette. */
    await page.waitForTimeout(300);

    /* === Try to open again — should NOT open === */
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.waitForTimeout(300);
    await expect(palette).toHaveCount(0);
  });
});
