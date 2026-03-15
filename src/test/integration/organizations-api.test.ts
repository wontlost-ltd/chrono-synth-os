import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
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

function seedTenantUser(
  os: ChronoSynthOS,
  app: FastifyInstance,
  tenantId: string,
  userId: string,
  email: string,
  role = 'member',
): AuthContext {
  const now = Date.now();
  os.getDatabase().prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, email, 'hash', role, tenantId, now, now);

  const accessToken = (app as FastifyInstance & {
    jwt: { sign: (payload: Record<string, unknown>) => string };
  }).jwt.sign({
    sub: userId,
    tenantId,
    role,
    planId: 'free',
  });

  return { userId, accessToken, tenantId };
}

describe('Organization API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(() => {
    os.close();
  });

  it('创建 organization 时同时创建默认 workspace 和 org_admin membership', async () => {
    const owner = await registerUser(app, 'org-owner@example.com');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeaders(owner),
      payload: {
        name: 'Acme Research',
        defaultWorkspaceName: 'Program Office',
      },
    });

    assert.equal(createResponse.statusCode, 201);
    const created = JSON.parse(createResponse.body).data as {
      organization: {
        organizationId: string;
        name: string;
        slug: string;
        defaultWorkspace: { name: string; slug: string; isDefault: boolean };
      };
      membership: {
        userId: string;
        roles: string[];
      };
    };

    assert.equal(created.organization.name, 'Acme Research');
    assert.equal(created.organization.slug, 'acme-research');
    assert.equal(created.organization.defaultWorkspace.name, 'Program Office');
    assert.equal(created.organization.defaultWorkspace.slug, 'program-office');
    assert.equal(created.organization.defaultWorkspace.isDefault, true);
    assert.equal(created.membership.userId, owner.userId);
    assert.deepEqual(created.membership.roles, ['org_admin']);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: authHeaders(owner),
    });
    assert.equal(listResponse.statusCode, 200);
    const organizations = JSON.parse(listResponse.body).data as Array<{ organizationId: string }>;
    assert.deepEqual(organizations.map((item) => item.organizationId), [created.organization.organizationId]);
  });

  it('org_admin 可添加成员，重复授予不会产生重复 role binding', async () => {
    const owner = await registerUser(app, 'org-admin@example.com');
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeaders(owner),
      payload: {
        name: 'Platform Guild',
      },
    });
    const organizationId = JSON.parse(createResponse.body).data.organization.organizationId as string;

    const invited = seedTenantUser(
      os,
      app,
      owner.tenantId,
      'user_org_member',
      'org-member@example.com',
    );

    const firstAdd = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: authHeaders(owner),
      payload: {
        email: 'org-member@example.com',
        roles: ['viewer', 'auditor'],
      },
    });
    assert.equal(firstAdd.statusCode, 200);

    const secondAdd = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: authHeaders(owner),
      payload: {
        email: 'org-member@example.com',
        roles: ['viewer', 'auditor'],
      },
    });
    assert.equal(secondAdd.statusCode, 200);

    const membersResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: authHeaders(owner),
    });
    assert.equal(membersResponse.statusCode, 200);

    const members = JSON.parse(membersResponse.body).data as Array<{
      userId: string;
      roles: string[];
      bindings: Array<{ role: string }>;
    }>;
    assert.equal(members.length, 2);

    const invitedMember = members.find((item) => item.userId === invited.userId);
    assert.ok(invitedMember);
    assert.deepEqual(invitedMember?.roles, ['auditor', 'viewer']);
    assert.deepEqual(invitedMember?.bindings.map((binding) => binding.role), ['auditor', 'viewer']);
  });

  it('可将 SCIM 创建的成员加入 organization 并授予 organization roles', async () => {
    const owner = await registerUser(app, 'org-scim-owner@example.com');
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/deployment/scim-token',
      headers: authHeaders(owner),
    });
    assert.equal(tokenResponse.statusCode, 200);
    const scimToken = (JSON.parse(tokenResponse.body).data as { token: string }).token;

    const scimCreateResponse = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: {
        authorization: `Bearer ${scimToken}`,
        'content-type': 'application/json',
      },
      payload: {
        userName: 'org-scim-member@example.com',
        active: true,
        name: { formatted: 'Org SCIM Member' },
      },
    });
    assert.equal(scimCreateResponse.statusCode, 201);
    const scimMember = JSON.parse(scimCreateResponse.body) as { id: string; userName: string };

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeaders(owner),
      payload: {
        name: 'SCIM Org',
      },
    });
    assert.equal(createResponse.statusCode, 201);
    const organizationId = JSON.parse(createResponse.body).data.organization.organizationId as string;

    const addResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: authHeaders(owner),
      payload: {
        email: scimMember.userName,
        roles: ['viewer', 'persona_operator'],
      },
    });
    assert.equal(addResponse.statusCode, 200);
    const added = JSON.parse(addResponse.body).data as {
      userId: string;
      email: string;
      roles: string[];
    };
    assert.equal(added.userId, scimMember.id);
    assert.equal(added.email, scimMember.userName);
    assert.deepEqual(added.roles, ['persona_operator', 'viewer']);

    const membersResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: authHeaders(owner),
    });
    assert.equal(membersResponse.statusCode, 200);
    const members = JSON.parse(membersResponse.body).data as Array<{ email: string; roles: string[] }>;
    const scimOrgMember = members.find((item) => item.email === scimMember.userName);
    assert.ok(scimOrgMember);
    assert.deepEqual(scimOrgMember?.roles, ['persona_operator', 'viewer']);
  });

  it('非成员用户不能访问其他 organization 的成员列表', async () => {
    const owner = await registerUser(app, 'org-isolation-owner@example.com');
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeaders(owner),
      payload: {
        name: 'Isolated Org',
      },
    });
    const organizationId = JSON.parse(createResponse.body).data.organization.organizationId as string;

    const outsider = seedTenantUser(
      os,
      app,
      owner.tenantId,
      'user_org_outsider',
      'org-outsider@example.com',
    );

    const listOwnOrgs = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: authHeaders(outsider),
    });
    assert.equal(listOwnOrgs.statusCode, 200);
    assert.deepEqual(JSON.parse(listOwnOrgs.body).data, []);

    const membersResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: authHeaders(outsider),
    });
    assert.equal(membersResponse.statusCode, 403);
    const body = JSON.parse(membersResponse.body);
    assert.equal(body.error, 'AuthorizationError');
    assert.equal(body.code, 'AUTH_INSUFFICIENT_ROLE');
  });
});
