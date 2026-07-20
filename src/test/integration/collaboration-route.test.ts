/**
 * 多数字人协同分析 HTTP 端点集成测试（Task 6，约束 10：route 测试放 integration，真 HTTP inject）。
 *
 * 只有走真实 app.inject 才能验证 HTTP 层三件事：
 *   1) 鉴权门（拒 API-key / service 主体 → 403，复用 companion 访问门口径）；
 *   2) fastify body schema 校验（空 question / 空 personaIds → 400）；
 *   3) 全局 error handler 映射（service 抛 NotFoundError → 404）+ 单键 {data} 信封。
 *
 * seed：persona 经 HTTP POST /api/v1/persona-core 建（getPersonaDetail 才非空）；记忆经与 app 同库的
 * TenantOSFactory 写进该 persona 的认知内核（getCore().addMemory，DB-backed，路由侧工厂读同一行），
 * 确保成功用例真 grounded、非空集假绿。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const ANALYZE_URL = '/api/v1/collaboration/analyze';

describe('协同分析 HTTP 端点 (/api/v1/collaboration/analyze)', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let db: IDatabase;
  /** 与 app 同库的工厂，仅用于把记忆写进目标 persona 的认知内核（路由侧工厂读同一 DB 行）。 */
  let seedFactory: TenantOSFactory;

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
    db = os.getDatabase();
    app = await createApp({ os, config, db });
    seedFactory = new TenantOSFactory(new SingleDbResolver(db), clock, logger);
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  /** 注册用户 → { accessToken, tenantId, userId }。 */
  async function registerUser(email: string): Promise<{ accessToken: string; tenantId: string; userId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    assert.equal(res.statusCode, 201, res.body);
    return JSON.parse(res.body).data;
  }

  function userHeaders(auth: { accessToken: string; tenantId: string }): Record<string, string> {
    return { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
  }

  /** 用给定 payload 自签 token（模拟 API-key / service 主体）。宽松签名类型：iat/exp 运行时注入。 */
  function signToken(payload: Record<string, unknown>): string {
    return (app as unknown as { jwt: { sign: (p: Record<string, unknown>) => string } }).jwt.sign(payload);
  }

  /** 经 HTTP 建真 persona，返回其 id（getPersonaDetail 才非空 → 通过 fail-closed 校验）。 */
  async function createPersona(auth: { accessToken: string; tenantId: string }, displayName: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/persona-core',
      headers: userHeaders(auth),
      payload: { displayName },
    });
    assert.equal(res.statusCode, 201, res.body);
    return JSON.parse(res.body).data.id as string;
  }

  /** 把记忆写进指定 persona 的认知内核（DB-backed，与路由侧工厂共享同一行）。 */
  function seedMemory(tenantId: string, personaId: string, content: string): void {
    seedFactory.getTenantOS(tenantId).getCore(personaId).addMemory('semantic', content, 0, 0.9);
  }

  it('未认证 → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      payload: { question: 'q', personaIds: ['pa'] },
    });
    assert.equal(res.statusCode, 401, res.body);
  });

  it('API-key 主体（apikey:* sub, role=service）→ 403（复用 companion 访问门）', async () => {
    const auth = await registerUser('collab-apikey@test.com');
    const apiKeyToken = signToken({
      sub: `apikey:${auth.userId}`, tenantId: auth.tenantId, role: 'service', planId: 'free',
    });
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      headers: { authorization: `Bearer ${apiKeyToken}`, 'x-tenant-id': auth.tenantId },
      payload: { question: 'q', personaIds: ['pa'] },
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('service 角色主体（非 apikey sub）→ 403（防御纵深双重判定）', async () => {
    const auth = await registerUser('collab-service@test.com');
    const serviceToken = signToken({
      sub: auth.userId, tenantId: auth.tenantId, role: 'service', planId: 'free',
    });
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      headers: { authorization: `Bearer ${serviceToken}`, 'x-tenant-id': auth.tenantId },
      payload: { question: 'q', personaIds: ['pa'] },
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('空 personaIds → 400（fastify schema）', async () => {
    const auth = await registerUser('collab-empty-personas@test.com');
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      headers: userHeaders(auth),
      payload: { question: 'q', personaIds: [] },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it('空 question → 400（fastify schema）', async () => {
    const auth = await registerUser('collab-empty-question@test.com');
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      headers: userHeaders(auth),
      payload: { question: '', personaIds: ['pa'] },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it('未知 persona → 404（service fail-closed，不泄露存在性）', async () => {
    const auth = await registerUser('collab-unknown-persona@test.com');
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      headers: userHeaders(auth),
      payload: { question: '投资 预算够吗', personaIds: ['does-not-exist'] },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('成功 → 200，信封 {data: CollaborativeReport}，requiresHumanApproval=true + modeId=multi_perspective', async () => {
    const auth = await registerUser('collab-success@test.com');
    const personaId = await createPersona(auth, '投资顾问');
    seedMemory(auth.tenantId, personaId, '投资 预算 约束 收紧');
    const res = await app.inject({
      method: 'POST',
      url: ANALYZE_URL,
      headers: userHeaders(auth),
      payload: { question: '投资 预算够吗', personaIds: [personaId] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    /* 单键 {data} 信封（前端自动解包）——变异自证：改成裸 report 此断言应红。 */
    assert.equal(body.data.requiresHumanApproval, true);
    assert.equal(body.data.modeId, 'multi_perspective');
    /* 真 grounded（非空集假绿）：seed 的记忆命中查询词「投资/预算」→ 视角有据。 */
    const view = body.data.perspectives.find((p: { personaId: string }) => p.personaId === personaId);
    assert.ok(view);
    assert.equal(view.kind, 'knowledge_grounded');
    assert.ok(view.evidence.length > 0);
  });
});
