import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { loadConfig } from '../../config/schema.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

interface AuthContext {
  userId: string;
  accessToken: string;
  tenantId: string;
}

function authHeaders(auth: AuthContext) {
  return {
    authorization: `Bearer ${auth.accessToken}`,
    'x-tenant-id': auth.tenantId,
  };
}

async function registerUser(app: FastifyInstance, email: string): Promise<AuthContext> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).data as AuthContext;
}

describe('Enterprise deployment / OIDC / SCIM 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    const masterKey = randomBytes(32).toString('base64');
    const tenantKey = randomBytes(32).toString('base64');
    const config = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      auth: { enabled: true, apiKeys: [], requireDbKeys: true },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      server: { publicUrl: 'https://api.example.test' },
      encryption: {
        enabled: true,
        masterKey,
        defaultKeyRef: 'master',
        keyring: { tenant_enterprise: tenantKey },
        keyRotationIntervalDays: 90,
      },
    });

    originalFetch = globalThis.fetch;
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    globalThis.fetch = originalFetch;
    os.close();
  });

  it('管理员可更新 dedicated deployment profile 并持久化加密的 OIDC secret', async () => {
    const admin = await registerUser(app, 'enterprise-admin@example.com');

    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/deployment/profile',
      headers: authHeaders(admin),
      payload: {
        deploymentMode: 'dedicated_db',
        databaseIsolationMode: 'dedicated',
        kafkaNamespace: 'tenant-enterprise',
        encryptionMode: 'tenant_dedicated',
        kmsKeyRef: 'tenant_enterprise',
        oidc: {
          enabled: true,
          issuerUrl: 'https://idp.example.test',
          clientId: 'tenant-client',
          clientSecret: 'super-secret-client-secret',
          audience: 'chrono-api',
          scope: 'openid profile email',
          emailClaim: 'email',
          nameClaim: 'name',
        },
      },
    });

    assert.equal(updateResponse.statusCode, 200);
    const updated = JSON.parse(updateResponse.body).data as {
      deploymentMode: string;
      databaseIsolationMode: string;
      kafkaNamespace: string;
      encryptionMode: string;
      kmsKeyRef: string;
      oidc: { enabled: boolean; clientSecretConfigured: boolean };
    };
    assert.equal(updated.deploymentMode, 'dedicated_db');
    assert.equal(updated.databaseIsolationMode, 'dedicated');
    assert.equal(updated.kafkaNamespace, 'tenant-enterprise');
    assert.equal(updated.encryptionMode, 'tenant_dedicated');
    assert.equal(updated.kmsKeyRef, 'tenant_enterprise');
    assert.equal(updated.oidc.enabled, true);
    assert.equal(updated.oidc.clientSecretConfigured, true);

    const row = os.getDatabase().prepare<{ oidc_client_secret_encrypted: string }>(
      'SELECT oidc_client_secret_encrypted FROM tenant_enterprise_profiles WHERE tenant_id = ?',
    ).get(admin.tenantId);
    assert.ok(row);
    assert.match(row.oidc_client_secret_encrypted, /^v2\.tenant_enterprise\./);
  });

  it('OIDC 回调可在已存在 tenant 下创建第二个用户并签发本地 JWT 会话', async () => {
    const admin = await registerUser(app, 'tenant-owner@example.com');
    const profileResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/deployment/profile',
      headers: authHeaders(admin),
      payload: {
        encryptionMode: 'tenant_dedicated',
        kmsKeyRef: 'tenant_enterprise',
        oidc: {
          enabled: true,
          issuerUrl: 'https://idp.example.test',
          clientId: 'tenant-client',
          clientSecret: 'tenant-secret',
        },
      },
    });
    assert.equal(profileResponse.statusCode, 200);

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === 'https://idp.example.test/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://idp.example.test',
          authorization_endpoint: 'https://idp.example.test/authorize',
          token_endpoint: 'https://idp.example.test/oauth/token',
          userinfo_endpoint: 'https://idp.example.test/userinfo',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://idp.example.test/oauth/token') {
        assert.equal(init?.method, 'POST');
        return new Response(JSON.stringify({
          access_token: 'oidc-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://idp.example.test/userinfo') {
        return new Response(JSON.stringify({
          sub: 'idp-user-1',
          email: 'member-from-oidc@example.com',
          name: 'OIDC Member',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const loginResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/login?redirect_uri=/console&tenant_id=${admin.tenantId}`,
    });
    assert.equal(loginResponse.statusCode, 302);
    const authorizeLocation = loginResponse.headers.location;
    assert.ok(authorizeLocation);
    const authorizeUrl = new URL(authorizeLocation);
    assert.equal(authorizeUrl.origin, 'https://idp.example.test');
    assert.equal(authorizeUrl.pathname, '/authorize');
    const state = authorizeUrl.searchParams.get('state');
    assert.ok(state);

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=test-code&state=${state}`,
    });
    assert.equal(callbackResponse.statusCode, 302);
    const redirectLocation = callbackResponse.headers.location;
    assert.ok(redirectLocation);
    const redirectUrl = new URL(redirectLocation);
    assert.equal(`${redirectUrl.origin}${redirectUrl.pathname}`, 'https://api.example.test/console');
    assert.match(redirectUrl.hash, /access_token=/);
    assert.match(redirectUrl.hash, /refresh_token=/);

    const user = os.getDatabase().prepare<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM users WHERE email = ? LIMIT 1',
    ).get('member-from-oidc@example.com');
    assert.ok(user);
    assert.equal(user.tenant_id, admin.tenantId);
  });

  it('SCIM token 可完成 create/list/delete 闭环且不依赖 API key 认证', async () => {
    const admin = await registerUser(app, 'scim-admin@example.com');

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/deployment/scim-token',
      headers: authHeaders(admin),
    });
    assert.equal(tokenResponse.statusCode, 200);
    const scimToken = (JSON.parse(tokenResponse.body).data as { token: string }).token;

    const createResponse = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: {
        authorization: `Bearer ${scimToken}`,
        'content-type': 'application/json',
      },
      payload: {
        userName: 'scim-user@example.com',
        active: true,
        name: { formatted: 'SCIM User' },
      },
    });
    assert.equal(createResponse.statusCode, 201);
    const created = JSON.parse(createResponse.body) as { id: string; userName: string };
    assert.equal(created.userName, 'scim-user@example.com');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=userName%20eq%20%22scim-user%40example.com%22',
      headers: {
        authorization: `Bearer ${scimToken}`,
      },
    });
    assert.equal(listResponse.statusCode, 200);
    const listed = JSON.parse(listResponse.body) as {
      totalResults: number;
      Resources: Array<{ id: string; userName: string }>;
    };
    assert.equal(listed.totalResults, 1);
    assert.equal(listed.Resources[0]?.id, created.id);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/scim/v2/Users/${created.id}`,
      headers: {
        authorization: `Bearer ${scimToken}`,
      },
    });
    assert.equal(deleteResponse.statusCode, 204);

    const listAfterDelete = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=userName%20eq%20%22scim-user%40example.com%22',
      headers: {
        authorization: `Bearer ${scimToken}`,
      },
    });
    assert.equal(listAfterDelete.statusCode, 200);
    assert.equal(JSON.parse(listAfterDelete.body).totalResults, 0);
  });
});

