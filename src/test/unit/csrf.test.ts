/**
 * P1-Y-api-baseline — CSRF double-submit token plugin tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerCsrf, DEFAULT_CSRF_OPTIONS } from '../../server/plugins/csrf.js';

function makeApp() {
  const app = Fastify();
  registerCsrf(app);
  app.post('/api/v1/auth/refresh', async () => ({ ok: true }));
  app.post('/api/v1/auth/logout', async () => ({ ok: true }));
  app.get('/api/v1/auth/refresh', async () => ({ ok: true }));
  /* A protected-but-not-listed path; should pass without CSRF check */
  app.post('/api/v1/other', async () => ({ ok: true }));
  return app;
}

describe('CSRF plugin', () => {
  it('lets GET requests through without a token', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/refresh' });
      assert.equal(res.statusCode, 200);
    } finally { await app.close(); }
  });

  it('lets non-cookie (Bearer) POSTs through — not CSRF-vulnerable', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        headers: { authorization: 'Bearer xyz' },
      });
      assert.equal(res.statusCode, 200);
    } finally { await app.close(); }
  });

  it('rejects 403 when refresh cookie present but no CSRF cookie / header', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        headers: { cookie: 'refresh_token=abc' },
      });
      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body) as { code: string };
      assert.equal(body.code, 'CSRF_TOKEN_MISMATCH');
    } finally { await app.close(); }
  });

  it('rejects 403 when header missing', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        headers: { cookie: 'refresh_token=abc; csrf_token=tok-1' },
      });
      assert.equal(res.statusCode, 403);
    } finally { await app.close(); }
  });

  it('rejects 403 when header value does not match cookie value', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refresh_token=abc; csrf_token=tok-1',
          'x-csrf-token': 'tok-2-evil',
        },
      });
      assert.equal(res.statusCode, 403);
    } finally { await app.close(); }
  });

  it('admits when cookie + header match', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refresh_token=abc; csrf_token=valid-tok',
          'x-csrf-token': 'valid-tok',
        },
      });
      assert.equal(res.statusCode, 200);
    } finally { await app.close(); }
  });

  it('only protects configured path prefixes', async () => {
    const app = makeApp();
    try {
      /* /api/v1/other not in protectedPathPrefixes; should pass through */
      const res = await app.inject({
        method: 'POST', url: '/api/v1/other',
        headers: { cookie: 'refresh_token=abc' },
      });
      assert.equal(res.statusCode, 200);
    } finally { await app.close(); }
  });

  it('default options gate /api/v1/auth/refresh and /api/v1/auth/logout', () => {
    assert.deepEqual(DEFAULT_CSRF_OPTIONS.protectedPathPrefixes, [
      '/api/v1/auth/refresh', '/api/v1/auth/logout',
    ]);
  });
});
