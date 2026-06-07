/**
 * Podman E2E smoke — runs against a real backend (no mocks).
 *
 * Prereqs: podman compose stack up + nginx proxying /api/, /healthz, /readyz.
 *
 * Scope: 5 happy-path checks that exercise the full nginx → fastify
 * pipeline. Auth flows are excluded (the dev backend exposes API key
 * routes; tests rely on no-auth /healthz + the public landing).
 */

import { test, expect } from '@playwright/test';

test('frontend healthz returns ok', async ({ request }) => {
  const res = await request.get('/frontend-healthz');
  expect(res.status()).toBe(200);
});

test('backend healthz reachable via nginx proxy', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(typeof body.uptime).toBe('number');
  expect(body.uptime).toBeGreaterThan(0);
});

test('backend readyz reports OK after migrations applied', async ({ request }) => {
  const res = await request.get('/readyz');
  expect(res.status()).toBe(200);
});

test('login page renders without crashing', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(/ChronoSynth/);
  /* Login form fields should be present */
  await expect(page.getByRole('textbox', { name: /邮箱|email/i }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /密码|password/i }).first()).toBeVisible();
});

test('runtime-config.js no longer 404s', async ({ request }) => {
  /* The fix from audit-fix-2 ships a fallback runtime-config.js so
   * preview/dev environments don't see console errors. */
  const res = await request.get('/runtime-config.js');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('__CHRONO_RUNTIME_CONFIG__');
});
