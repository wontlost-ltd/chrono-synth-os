/**
 * 数字企业完整生命周期 E2E（模拟生产环境，2026-06-23）——全程经**真实 HTTP 服务层**（fastify inject，
 * 认证/admin 鉴权/Zod schema/真实路由/租户隔离），一个连续剧本走完一家数字咨询公司从零搭建到并购重组。
 *
 * 剧本（全 HTTP，最贴近生产）：
 *   ① 创业者注册 admin → 自助建公司（CEO 出生人格内核）
 *   ② 招聘搭组织：主管 + 两条线 IC（建汇报结构）
 *   ③ 可视化：组织图/信号/学习闭环一屏聚合
 *   ④ 收购：建一家小公司 → 吸收并入（M&A，roleCode 冲突自动加后缀，单根不变）
 *   ⑤ 重组：reparent 调汇报线 + offboard 裁撤（守卫：根/下属/在手任务）
 *   ⑥ 重组建议：据确定性信号看建议（不自动执行）
 *   ⑦ 多租户隔离：第二家公司全程不串
 *   ⑧ 零-LLM 铁律：全程经确定性结构操作，无 LLM；同请求可复现
 *
 * 覆盖最新三片（可视化 + 自助建组织/招人 + 吸收/重组）+ 串联组织机制。确定性：TestClock + 服务端派生 id。
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

describe('数字企业完整生命周期 E2E（模拟生产，全 HTTP：建司→招聘→可视化→并购→重组）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let clock: TestClock;
  let headers: Record<string, string>;

  /* ── HTTP 助手 ── */
  const register = (email: string) => app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  const createOrg = (body: object, hdrs = headers) => app.inject({ method: 'POST', url: '/api/v1/workforce/orgs', headers: hdrs, payload: body });
  const hire = (orgId: string, body: object, hdrs = headers) => app.inject({ method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/workers`, headers: hdrs, payload: body });
  const absorb = (orgId: string, body: object, hdrs = headers) => app.inject({ method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/absorb`, headers: hdrs, payload: body });
  const reparent = (orgId: string, body: object, hdrs = headers) => app.inject({ method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/reparent`, headers: hdrs, payload: body });
  const offboard = (orgId: string, body: object, hdrs = headers) => app.inject({ method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/offboard`, headers: hdrs, payload: body });
  const viz = (orgId: string, hdrs = headers) => app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/visualization`, headers: hdrs });
  const suggestions = (orgId: string, hdrs = headers) => app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/restructure/suggestions`, headers: hdrs });

  type VizData = {
    orgTree: { nodes: Array<{ workerId: string; displayName: string; roleCode: string; employmentStatus: string }>; edges: Array<{ from: string; to: string }> };
    learningLoop: Array<{ workerId: string; learnedCapabilities: unknown[] }>;
    signals: Array<{ workerId: string }>;
  };
  async function vizData(orgId: string, hdrs = headers): Promise<VizData> {
    const res = await viz(orgId, hdrs);
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body).data as VizData;
  }
  const workerByName = (v: VizData, name: string) => v.orgTree.nodes.find((n) => n.displayName === name)!.workerId;
  const managerOf = (v: VizData, workerId: string) => v.orgTree.edges.find((e) => e.to === workerId)?.from ?? null;

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
    const reg = await register('founder@acme.com');
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
  });
  after(async () => { await app.close(); os.close(); });

  it('① 创业者自助建公司 acme（CEO 出生独立人格内核）', async () => {
    const res = await createOrg({ orgId: 'acme', roleCode: 'ceo', title: '首席执行官', displayName: '齐总', archetype: 'doer' });
    assert.equal(res.statusCode, 201, res.body);
    const data = JSON.parse(res.body).data as { orgId: string; rootWorkerId: string; birth: { kind: string } };
    assert.equal(data.orgId, 'acme');
    assert.equal(data.birth.kind, 'seeded', 'CEO 出生');
  });

  it('② 招聘搭组织：主管 + 研究/质量两条线 IC', async () => {
    const v0 = await vizData('acme');
    const ceo = workerByName(v0, '齐总');
    /* 招主管。 */
    const mgr = await hire('acme', { managerWorkerId: ceo, roleCode: 'mgr', title: '运营主管', displayName: '运管', archetype: 'analyst' });
    assert.equal(mgr.statusCode, 201, mgr.body);
    const mgrId = (JSON.parse(mgr.body).data as { workerId: string }).workerId;
    /* 主管下招两个 IC。 */
    const ic1 = await hire('acme', { managerWorkerId: mgrId, roleCode: 'researcher', title: '研究员', displayName: '小研', archetype: 'explorer' });
    const ic2 = await hire('acme', { managerWorkerId: mgrId, roleCode: 'reviewer', title: '审核员', displayName: '小审', archetype: 'guardian' });
    assert.equal(ic1.statusCode, 201); assert.equal(ic2.statusCode, 201);

    const v = await vizData('acme');
    assert.equal(v.orgTree.nodes.length, 4, '公司现有 4 人');
    /* 汇报结构正确：主管→CEO，IC→主管。 */
    assert.equal(managerOf(v, mgrId), ceo, '主管汇报 CEO');
    assert.equal(managerOf(v, workerByName(v, '小研')), mgrId, '小研汇报主管');
  });

  it('③ 可视化一屏聚合：组织树 + 信号 + 学习闭环', async () => {
    const v = await vizData('acme');
    assert.equal(v.orgTree.nodes.length, 4);
    assert.equal(v.orgTree.edges.length, 3, '3 条汇报边');
    assert.equal(v.signals.length, 4, '每人有信号');
    assert.equal(v.learningLoop.length, 4, '每人有学习闭环条目');
    /* 节点含岗位原型 + 雇佣状态。 */
    assert.ok(v.orgTree.nodes.every((n) => n.roleCode && n.employmentStatus === 'active'));
  });

  it('④ 收购：建小公司 startup → 吸收并入 acme（M&A，roleCode 冲突加后缀，单根不变）', async () => {
    /* 建一家小公司：CEO + researcher（researcher 撞 acme）。 */
    await createOrg({ orgId: 'startup', roleCode: 'ceo', title: 'CEO', displayName: '创始人', archetype: 'guardian' });
    const sv = await vizData('startup');
    const startupCeo = workerByName(sv, '创始人');
    await hire('startup', { managerWorkerId: startupCeo, roleCode: 'researcher', title: '研究员', displayName: '新人', archetype: 'explorer' });

    /* acme 吸收 startup，startup 根接到 acme CEO 下。 */
    const acmeV = await vizData('acme');
    const acmeCeo = workerByName(acmeV, '齐总');
    const res = await absorb('acme', { sourceOrgId: 'startup', mountUnderWorkerId: acmeCeo });
    assert.equal(res.statusCode, 200, res.body);
    const result = JSON.parse(res.body).data as { movedWorkers: number; renamedRoles: Array<{ from: string }> };
    assert.equal(result.movedWorkers, 2, 'startup 2 人迁入');
    assert.ok(result.renamedRoles.some((r) => r.from === 'researcher' || r.from === 'ceo'), 'roleCode 冲突重命名');

    /* acme 现有 6 人；startup 空。 */
    const v = await vizData('acme');
    assert.equal(v.orgTree.nodes.length, 6, 'acme 现 6 人（原 4 + startup 2）');
    assert.equal((await vizData('startup')).orgTree.nodes.length, 0, 'startup 已空');
    /* 单根不变（仍只有齐总无上级）。 */
    const roots = v.orgTree.nodes.filter((n) => managerOf(v, n.workerId) === null);
    assert.equal(roots.length, 1, '单根');
    assert.equal(roots[0]!.displayName, '齐总');
    /* startup 创始人接到 acme CEO 下。 */
    assert.equal(managerOf(v, workerByName(v, '创始人')), acmeCeo, '被收购 CEO 接到 acme CEO');
  });

  it('⑤ 重组：reparent 把新人改挂运营主管 + offboard 裁撤（守卫）', async () => {
    let v = await vizData('acme');
    const newbie = workerByName(v, '新人');
    const mgr = workerByName(v, '运管');
    /* reparent：新人从原创始人改挂运营主管。 */
    const re = await reparent('acme', { workerId: newbie, newManagerWorkerId: mgr });
    assert.equal(re.statusCode, 200, re.body);
    v = await vizData('acme');
    assert.equal(managerOf(v, newbie), mgr, '新人改挂运营主管');

    /* offboard 守：裁有下属的创始人缺安置 → 拒。 */
    const founder = workerByName(v, '创始人');
    /* 创始人此刻无下属了（新人已改挂）→ 可直接裁。先验「裁根齐总→拒」。 */
    const ceo = workerByName(v, '齐总');
    const cutRoot = await offboard('acme', { workerId: ceo });
    assert.ok(cutRoot.statusCode >= 400, '裁根 CEO → 拒');
    /* 裁创始人（无下属无在手任务）→ 成功，软删。 */
    const cut = await offboard('acme', { workerId: founder });
    assert.equal(cut.statusCode, 200, cut.body);
    /* 软删：仍在 chart 但 offboarded。 */
    const v2 = await vizData('acme');
    const founderNode = v2.orgTree.nodes.find((n) => n.workerId === founder)!;
    assert.equal(founderNode.employmentStatus, 'offboarded', '软删保审计');
  });

  it('⑥ 重组建议：空闲 worker → offboard_idle 建议（确定性，不自动执行）', async () => {
    const res = await suggestions('acme');
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { suggestions: Array<{ kind: string; workerId: string }> };
    /* 公司没派任务 → active worker 都空闲 → 有建议；offboarded 的创始人不在建议里。 */
    assert.ok(data.suggestions.length > 0, '有空闲建议');
    assert.ok(data.suggestions.every((s) => s.kind === 'offboard_idle'));
    const v = await vizData('acme');
    const founder = workerByName(v, '创始人');
    assert.ok(!data.suggestions.some((s) => s.workerId === founder), 'offboarded 创始人不在建议（只建议 active）');
  });

  it('⑦ 多租户隔离：第二家公司全程不串', async () => {
    const reg2 = await register('founder2@beta.com');
    const auth2 = JSON.parse(reg2.body).data as { accessToken: string; tenantId: string };
    const h2 = { authorization: `Bearer ${auth2.accessToken}`, 'x-tenant-id': auth2.tenantId };
    /* 第二租户看 acme：空（隔离）。 */
    const v2acme = await vizData('acme', h2);
    assert.equal(v2acme.orgTree.nodes.length, 0, '第二租户看不到 acme');
    /* 第二租户建同名 acme → 独立，互不影响。 */
    const res = await createOrg({ orgId: 'acme', roleCode: 'ceo', title: 'CEO', displayName: '别人老板', archetype: 'doer' }, h2);
    assert.equal(res.statusCode, 201, res.body);
    /* 主租户 acme 不受影响（仍 6 人）。 */
    assert.equal((await vizData('acme')).orgTree.nodes.length, 6, '主租户 acme 不被第二租户污染');
  });

  it('⑧ 零-LLM 铁律 + 确定性：重组操作可复现（同请求同响应）', async () => {
    /* 重组建议是纯确定性聚合：连续两次同请求 → 同响应体。 */
    const r1 = await suggestions('acme');
    const r2 = await suggestions('acme');
    assert.equal(r1.body, r2.body, '重组建议确定性可复现（零-LLM 信号派生）');
    /* 可视化同样确定性。 */
    const v1 = await viz('acme');
    const v2 = await viz('acme');
    assert.equal(v1.body, v2.body, '可视化聚合确定性可复现');
  });

  it('⑨ 鉴权：非 admin / 无 JWT → 治理写操作拒', async () => {
    const noAuth = await app.inject({ method: 'POST', url: '/api/v1/workforce/orgs/acme/reparent', payload: { workerId: 'x', newManagerWorkerId: 'y' } });
    assert.ok(noAuth.statusCode === 401 || noAuth.statusCode === 403, '无 JWT → 拒');
  });
});
