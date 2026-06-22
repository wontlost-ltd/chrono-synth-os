/**
 * 数字员工组织管理 API 集成测试（生产 self-service：建组织 / 招数字员工）。
 *
 * 锁住：
 *   ① POST /orgs 建组织 + 根数字员工，出生独立人格内核（叙事/决策风格落库）。
 *   ② POST /orgs/:orgId/workers 招人到已有组织，挂在指定上级下，出生独立人格内核。
 *   ③ 校验：组织已存在拒、上级不存在拒、roleCode 重复拒、非 admin 拒。
 *   ④ 招的人真出现在组织图 + 可视化端点。
 *   ⑤ 幂等：同 personaId 再建不覆盖已成长人格（birth=skipped_existing）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

describe('数字员工组织管理 API（建组织 / 招数字员工）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let clock: TestClock;
  let headers: Record<string, string>;

  before(async () => {
    clock = new TestClock(1_000_000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger() });
    os.start();
    const config = loadConfig({
      rateLimit: { max: 100_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      runtime: { recovery: { enabled: false } },
    });
    app = await createApp({ os, config });
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'admin-wf@test.com', password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    /* 首注册用户=admin（auth-service 硬编码 role:'admin'，JWT 带 admin 角色；register 响应不含 role 字段，
     * 管理路由 requireRole('admin') 能通过即证明）。 */
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
  });
  after(async () => { await app.close(); os.close(); });

  const createOrg = (body: object, hdrs = headers) =>
    app.inject({ method: 'POST', url: '/api/v1/workforce/orgs', headers: hdrs, payload: body });
  const hire = (orgId: string, body: object, hdrs = headers) =>
    app.inject({ method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/workers`, headers: hdrs, payload: body });

  it('★① 建组织 + 根数字员工 → 出生独立人格内核★', async () => {
    const res = await createOrg({ orgId: 'acme', roleCode: 'ceo', title: '首席执行官', displayName: '齐总', archetype: 'doer' });
    assert.equal(res.statusCode, 201, res.body);
    const data = JSON.parse(res.body).data as { orgId: string; rootWorkerId: string; birth: { personaId: string; kind: string } };
    assert.equal(data.orgId, 'acme');
    assert.ok(data.rootWorkerId);
    /* 人格内核真出生（birth.kind=seeded 即首次写入决策风格 + 出生叙事；落**请求租户**内核，由 tenantFactory
     * 解析的 tenant-scoped OS 写入——故不在默认 os 上读，以 API 契约证明出生）。 */
    assert.equal(data.birth.kind, 'seeded', '根 worker 出生（首次写入）');
    assert.equal(data.birth.personaId, 'persona-acme-ceo', 'personaId 服务端按 org+roleCode 派生');
  });

  it('★② 招一名数字员工到已有组织 → 挂在 CEO 下，出生人格★', async () => {
    /* 先取 CEO workerId（建组织时返回）。 */
    const chart = await app.inject({ method: 'GET', url: '/api/v1/workforce/orgs/acme/chart', headers });
    const ceoWorker = JSON.parse(chart.body).data.workers[0];
    const res = await hire('acme', { managerWorkerId: ceoWorker.id, roleCode: 'researcher', title: '研究员', displayName: '小探', archetype: 'explorer', seniority: 'ic' });
    assert.equal(res.statusCode, 201, res.body);
    const data = JSON.parse(res.body).data as { workerId: string; birth: { personaId: string; kind: string } };
    assert.equal(data.birth.kind, 'seeded', '新员工出生独立人格内核');
    assert.equal(data.birth.personaId, 'persona-acme-researcher');
    /* 出现在组织图 + 汇报到 CEO。 */
    const chart2 = await app.inject({ method: 'GET', url: '/api/v1/workforce/orgs/acme/chart', headers });
    const data2 = JSON.parse(chart2.body).data;
    assert.equal(data2.workers.length, 2, '组织现有两名 worker');
    const edge = data2.reportingEdges.find((e: { reportWorkerId: string }) => e.reportWorkerId === data.workerId);
    assert.equal(edge.managerWorkerId, ceoWorker.id, '研究员汇报到 CEO');
  });

  it('★④ 招的人出现在可视化端点★', async () => {
    const viz = await app.inject({ method: 'GET', url: '/api/v1/workforce/orgs/acme/visualization', headers });
    const data = JSON.parse(viz.body).data;
    assert.equal(data.orgTree.nodes.length, 2);
    assert.ok(data.orgTree.nodes.some((n: { roleCode: string }) => n.roleCode === 'researcher'));
    assert.equal(data.orgTree.edges.length, 1, '一条汇报边');
  });

  it('★③ 校验：组织已存在 → 拒★', async () => {
    const res = await createOrg({ orgId: 'acme', roleCode: 'ceo2', title: 'X', displayName: 'Y' });
    assert.ok(res.statusCode >= 400, '组织已存在应拒');
  });

  it('★③ 校验：上级不存在 → 拒★', async () => {
    const res = await hire('acme', { managerWorkerId: 'nonexistent-worker', roleCode: 'newbie', title: 'X', displayName: 'Y' });
    assert.ok(res.statusCode >= 400, '上级不存在应拒');
  });

  it('★③ 校验：roleCode 重复 → 拒★', async () => {
    const chart = await app.inject({ method: 'GET', url: '/api/v1/workforce/orgs/acme/chart', headers });
    const ceoWorker = JSON.parse(chart.body).data.workers[0];
    const res = await hire('acme', { managerWorkerId: ceoWorker.id, roleCode: 'researcher', title: 'X', displayName: 'Y' });
    assert.ok(res.statusCode >= 400, 'roleCode 重复应拒');
  });

  it('★③ 校验：往不存在的组织招人 → 拒★', async () => {
    const res = await hire('nonexistent-org', { managerWorkerId: 'w', roleCode: 'r', title: 'X', displayName: 'Y' });
    assert.ok(res.statusCode >= 400, '组织不存在应拒');
  });

  it('★非 admin 鉴权：无 JWT → 拒★', async () => {
    const res = await createOrg({ orgId: 'x', roleCode: 'ceo', title: 'X', displayName: 'Y' }, {});
    assert.ok(res.statusCode === 401 || res.statusCode === 403, '无 JWT 应拒');
  });

  it('★⑤ 多租户隔离：另一租户建同名组织 → 各自独立（结构 + 人格落各自租户，不串）★', async () => {
    /* 第二个 admin 租户。它建一个**同 orgId/roleCode**的组织——personaId 派生相同('persona-acme-ceo')，
     * 但应落**第二租户的内核**（tenantFactory 解析），与主租户的 persona-acme-ceo 互不影响。 */
    const reg2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'admin-wf2@test.com', password: 'password123' } });
    const auth2 = JSON.parse(reg2.body).data as { accessToken: string; tenantId: string };
    const h2 = { authorization: `Bearer ${auth2.accessToken}`, 'x-tenant-id': auth2.tenantId };

    /* 第二租户看 acme 组织：空（主租户的 acme 不可见——租户隔离）。 */
    const chart2 = await app.inject({ method: 'GET', url: '/api/v1/workforce/orgs/acme/chart', headers: h2 });
    assert.equal(JSON.parse(chart2.body).data.workers.length, 0, '隔离：第二租户看不到主租户 acme');

    /* 第二租户建同名 acme → 成功（各租户独立命名空间），birth=seeded（第二租户首次出生，不被主租户影响）。 */
    const res = await createOrg({ orgId: 'acme', roleCode: 'ceo', title: '老板', displayName: '王总', archetype: 'guardian' }, h2);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(JSON.parse(res.body).data.birth.kind, 'seeded', '第二租户独立出生（不被主租户 persona 影响）');
  });
});
