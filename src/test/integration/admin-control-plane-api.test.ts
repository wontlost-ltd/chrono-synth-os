import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

describe('Admin Control Plane API 集成测试', () => {
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

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('admin 端点返回 persona/task/wallet/governance 分页与 summary', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'admin-control@example.com', password: 'password123' },
    });
    assert.equal(registerRes.statusCode, 201);
    const auth = JSON.parse(registerRes.body).data as {
      userId: string;
      accessToken: string;
      tenantId: string;
    };

    const personaService = new PersonaCoreService(os.getDatabase());
    const persona = personaService.createPersona({
      tenantId: auth.tenantId,
      ownerUserId: auth.userId,
      displayName: 'Admin Persona',
    });
    const task = personaService.publishTask({
      tenantId: auth.tenantId,
      publisherUserId: auth.userId,
      title: 'Admin Task',
      description: 'Exercise admin control plane task list',
      reward: 42,
    });
    const governanceCase = personaService.openGovernanceCase({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      personaId: persona.id,
      taskId: task.id,
      triggerType: 'manual_review',
      severity: 'high',
      details: { source: 'admin-test' },
    });
    assert.ok(governanceCase);

    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      'x-tenant-id': auth.tenantId,
    };

    const personasRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/personas?page=1&pageSize=10',
      headers,
    });
    assert.equal(personasRes.statusCode, 200);
    const personasBody = JSON.parse(personasRes.body);
    assert.equal(personasBody.summary.total, 1);
    assert.equal(personasBody.summary.active, 1);
    assert.equal(personasBody.data[0].displayName, 'Admin Persona');

    const tasksRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tasks?page=1&pageSize=10',
      headers,
    });
    assert.equal(tasksRes.statusCode, 200);
    const tasksBody = JSON.parse(tasksRes.body);
    assert.equal(tasksBody.summary.total, 1);
    assert.equal(tasksBody.summary.open, 1);
    assert.equal(tasksBody.data[0].title, 'Admin Task');

    const walletsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/wallets?page=1&pageSize=10',
      headers,
    });
    assert.equal(walletsRes.statusCode, 200);
    const walletsBody = JSON.parse(walletsRes.body);
    assert.equal(walletsBody.summary.total, 1);
    assert.equal(walletsBody.summary.active, 1);
    assert.equal(walletsBody.data[0].personaId, persona.id);

    const governanceRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/governance?page=1&pageSize=10',
      headers,
    });
    assert.equal(governanceRes.statusCode, 200);
    const governanceBody = JSON.parse(governanceRes.body);
    assert.equal(governanceBody.summary.total, 1);
    assert.equal(governanceBody.summary.open, 1);
    assert.equal(governanceBody.data[0].caseId, governanceCase!.id);
    assert.equal(governanceBody.data[0].triggerType, 'manual_review');
  });
});
