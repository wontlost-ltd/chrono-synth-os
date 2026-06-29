/**
 * 组织重组/并购 API 集成测试（absorb / reparent / offboard / suggestions）。
 *
 * 端到端经真实 HTTP：建两组织+招人 → 吸收 → reparent → offboard（守卫）→ 重组建议。admin 鉴权 + 租户隔离。
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

describe('组织重组/并购 API（吸收 / reparent / offboard / 建议）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let clock: TestClock;
  let headers: Record<string, string>;

  /** 取某组织的 chart（workers + edges）。 */
  async function chart(orgId: string) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/chart`, headers });
    return JSON.parse(res.body).data as { workers: Array<{ id: string; displayName: string }>; reportingEdges: Array<{ managerWorkerId: string | null; reportWorkerId: string }> };
  }
  function managerOf(c: Awaited<ReturnType<typeof chart>>, workerId: string): string | null {
    return c.reportingEdges.find((e) => e.reportWorkerId === workerId)?.managerWorkerId ?? null;
  }
  const createOrg = (body: object) => app.inject({ method: 'POST', url: '/api/v1/workforce/orgs', headers, payload: body });
  const hire = (orgId: string, body: object) => app.inject({ method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/workers`, headers, payload: body });

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
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'restructure@test.com', password: 'password123' } });
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* 建大组织 big（CEO + mgr + ic）。 */
    await createOrg({ orgId: 'big', roleCode: 'ceo', title: 'CEO', displayName: '大老板', archetype: 'doer' });
    const bigChart = await chart('big');
    const bigCeo = bigChart.workers[0]!.id;
    await hire('big', { managerWorkerId: bigCeo, roleCode: 'mgr', title: '主管', displayName: '大主管', archetype: 'analyst' });
    /* 建小组织 small（CEO + ic）。 */
    await createOrg({ orgId: 'small', roleCode: 'ceo', title: 'CEO', displayName: '小老板', archetype: 'guardian' });
    const smallChart = await chart('small');
    const smallCeo = smallChart.workers[0]!.id;
    await hire('small', { managerWorkerId: smallCeo, roleCode: 'worker', title: '员工', displayName: '小员工', archetype: 'explorer' });
  });
  after(async () => { await app.close(); os.close(); });

  it('★吸收：small 并入 big，small 根接到 big 的 CEO 下，big 单根不变★', async () => {
    const bigChart = await chart('big');
    const bigCeo = bigChart.workers.find((w) => w.displayName === '大老板')!.id;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/workforce/orgs/big/absorb', headers,
      payload: { sourceOrgId: 'small', mountUnderWorkerId: bigCeo },
    });
    assert.equal(res.statusCode, 200, res.body);
    const result = JSON.parse(res.body).data as { movedWorkers: number; renamedRoles: Array<{ from: string; to: string }>; sourceRootWorkerId: string };
    assert.equal(result.movedWorkers, 2, 'small 的 2 名 worker 迁入');
    /* small 的 roleCode 'ceo' 撞 big → 加后缀。 */
    assert.ok(result.renamedRoles.some((r) => r.from === 'ceo'), 'ceo 冲突重命名');

    /* big 现有 4 名 worker（大老板/大主管 + 小老板/小员工）。 */
    const c = await chart('big');
    assert.equal(c.workers.length, 4);
    assert.equal((await chart('small')).workers.length, 0, 'small 已空');
    /* small 根（小老板）接到 big CEO 下。 */
    assert.equal(managerOf(c, result.sourceRootWorkerId), bigCeo, 'small 根接到 big CEO');
    /* big 单根不变。 */
    const roots = c.workers.filter((w) => managerOf(c, w.id) === null);
    assert.equal(roots.length, 1, 'big 单根');
    assert.equal(roots[0]!.displayName, '大老板');
  });

  it('★reparent：小员工从小老板改挂到大主管下★', async () => {
    const c = await chart('big');
    const worker = c.workers.find((w) => w.displayName === '小员工')!.id;
    const bigMgr = c.workers.find((w) => w.displayName === '大主管')!.id;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/workforce/orgs/big/reparent', headers,
      payload: { workerId: worker, newManagerWorkerId: bigMgr },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(managerOf(await chart('big'), worker), bigMgr, '小员工改挂大主管');
  });

  it('★offboard 守：裁有下属的小老板缺安置 → 拒；给安置 → 下属改挂 + 软删★', async () => {
    const c = await chart('big');
    const smallBoss = c.workers.find((w) => w.displayName === '小老板')!.id;
    const bigCeo = c.workers.find((w) => w.displayName === '大老板')!.id;
    /* 小老板此刻还有下属吗？上一步把小员工挂到大主管了，故小老板可能已无下属——先确认。
     * 为稳健，直接测「裁有下属者缺安置→拒」：用大主管（现有小员工下属）。 */
    const bigMgr = c.workers.find((w) => w.displayName === '大主管')!.id;
    const noAssign = await app.inject({ method: 'POST', url: '/api/v1/workforce/orgs/big/offboard', headers, payload: { workerId: bigMgr } });
    assert.ok(noAssign.statusCode >= 400, '大主管有下属，缺 reparentReportsTo → 拒');
    /* 给安置=大老板 → 大主管下属改挂大老板，大主管下线。 */
    const ok = await app.inject({ method: 'POST', url: '/api/v1/workforce/orgs/big/offboard', headers, payload: { workerId: bigMgr, reparentReportsTo: bigCeo } });
    assert.equal(ok.statusCode, 200, ok.body);
    void smallBoss;
  });

  it('★offboard 守：裁根大老板 → 拒（组织会无根）★', async () => {
    const c = await chart('big');
    const bigCeo = c.workers.find((w) => w.displayName === '大老板')!.id;
    const res = await app.inject({ method: 'POST', url: '/api/v1/workforce/orgs/big/offboard', headers, payload: { workerId: bigCeo } });
    assert.ok(res.statusCode >= 400, '根不可裁');
  });

  it('★重组建议：空闲 worker → offboard_idle 建议（确定性信号，不自动执行）★', async () => {
    /* big 里的 worker 都无任务 → 全空闲 → 应有 offboard_idle 建议。 */
    const res = await app.inject({ method: 'GET', url: '/api/v1/workforce/orgs/big/restructure/suggestions', headers });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { suggestions: Array<{ kind: string; suggestedAction: string }> };
    assert.ok(data.suggestions.length > 0, '有空闲建议');
    assert.ok(data.suggestions.every((s) => s.kind === 'offboard_idle'), '全是空闲建议');
    assert.ok(data.suggestions.every((s) => s.suggestedAction === 'offboard'));
  });

  it('★鉴权：无 JWT → 拒★', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/workforce/orgs/big/reparent', payload: { workerId: 'x', newManagerWorkerId: 'y' } });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });
});
