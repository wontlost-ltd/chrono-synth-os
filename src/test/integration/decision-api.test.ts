import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('决策 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    intelligence: { provider: 'mock', model: 'test', embeddingModel: 'mock-embed' },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    /* 设置一些人格数据 */
    os.core.addValue('诚实', 0.8);
    os.core.addValue('勇气', 0.6);
    os.core.addSurvivalAnchor('安全', 'constraint', null, 4);
    os.core.setDecisionStyle({ riskAppetite: 0.3 });
    app = await createApp({ os, config });
  });

  afterEach(() => {
    os.close();
  });

  describe('POST /api/v1/decisions', () => {
    it('创建决策案例', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: {
          title: '职业选择',
          description: '是否应该换工作',
          alternatives: ['留在现公司', '跳槽到新公司'],
          constraints: ['收入不能降低'],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id.startsWith('dec_'));
      assert.equal(body.data.title, '职业选择');
      assert.equal(body.data.alternatives.length, 2);
      assert.equal(body.data.constraints.length, 1);
    });

    it('缺少 title 返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { description: '无标题' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('缺少 description 返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { title: '无描述' },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('POST /api/v1/decisions/:id/simulate', () => {
    it('运行模拟并返回结果', async () => {
      /* 先创建决策 */
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: {
          title: '投资决策',
          description: '是否投资新项目',
          alternatives: ['投资', '观望'],
        },
      });
      const decisionId = JSON.parse(createRes.body).data.id;

      /* 运行模拟 */
      const simRes = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/simulate`,
      });

      assert.equal(simRes.statusCode, 200);
      const simBody = JSON.parse(simRes.body);
      assert.ok(simBody.data.runId.startsWith('run_'));
      assert.ok(simBody.data.result);
      assert.equal(simBody.data.result.caseId, decisionId);
      assert.ok(simBody.data.result.recommendedAlternative);
      assert.ok(Array.isArray(simBody.data.result.rankedOptions));
      assert.equal(simBody.data.result.rankedOptions.length, 2);
    });

    it('不存在的决策返回 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions/dec_nonexistent/simulate',
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /api/v1/decisions/:id/runs/:runId', () => {
    it('获取模拟结果', async () => {
      /* 创建 + 模拟 */
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: {
          title: '测试',
          description: '测试获取运行结果',
          alternatives: ['A', 'B'],
        },
      });
      const decisionId = JSON.parse(createRes.body).data.id;

      const simRes = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/simulate`,
      });
      const { runId } = JSON.parse(simRes.body).data;

      /* 获取结果 */
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/decisions/${decisionId}/runs/${runId}`,
      });

      assert.equal(getRes.statusCode, 200);
      const body = JSON.parse(getRes.body);
      assert.equal(body.data.runId, runId);
      assert.ok(body.data.result);
      assert.equal(body.data.result.caseId, decisionId);
    });

    it('不存在的 runId 返回 404', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { title: '测试', description: '测试', alternatives: ['A', 'B'] },
      });
      const decisionId = JSON.parse(createRes.body).data.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/decisions/${decisionId}/runs/run_nonexistent`,
      });
      assert.equal(res.statusCode, 404);
    });

    it('caseId 不匹配返回 404', async () => {
      /* 在 case1 下创建 run */
      const c1 = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { title: 'Case1', description: 'test', alternatives: ['A', 'B'] },
      });
      const id1 = JSON.parse(c1.body).data.id;

      const sim = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${id1}/simulate`,
      });
      const { runId } = JSON.parse(sim.body).data;

      /* 在 case2 下查询 case1 的 run */
      const c2 = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { title: 'Case2', description: 'test', alternatives: ['X', 'Y'] },
      });
      const id2 = JSON.parse(c2.body).data.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/decisions/${id2}/runs/${runId}`,
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /api/v1/decisions/:id/feedback', () => {
    it('提交反馈成功', async () => {
      /* 创建 + 模拟 */
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: {
          title: '反馈测试',
          description: '测试反馈端点',
          alternatives: ['选项A', '选项B'],
        },
      });
      const decisionId = JSON.parse(createRes.body).data.id;

      const simRes = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/simulate`,
      });
      const { runId } = JSON.parse(simRes.body).data;

      /* 提交反馈 */
      const feedbackRes = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/feedback`,
        payload: {
          runId,
          selectedAlternative: '选项A',
          satisfaction: 0.8,
          notes: '实际体验良好',
        },
      });

      assert.equal(feedbackRes.statusCode, 200);
      const body = JSON.parse(feedbackRes.body);
      assert.equal(body.data.runId, runId);
      assert.equal(body.data.stored, true);
    });

    it('不存在的 runId 返回 404', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { title: '测试', description: '测试', alternatives: ['A', 'B'] },
      });
      const decisionId = JSON.parse(createRes.body).data.id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/feedback`,
        payload: {
          runId: 'run_nonexistent',
          selectedAlternative: 'A',
          satisfaction: 0.5,
        },
      });
      assert.equal(res.statusCode, 404);
    });

    it('缺少必填字段返回 400', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: { title: '测试', description: '测试', alternatives: ['A', 'B'] },
      });
      const decisionId = JSON.parse(createRes.body).data.id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/feedback`,
        payload: { runId: 'run_xxx' },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('端到端：完整决策流程', () => {
    it('创建 → 模拟 → 查看结果 → 反馈', async () => {
      /* 1. 创建决策 */
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/decisions',
        payload: {
          title: '生活方式选择',
          description: '要不要搬到另一个城市',
          alternatives: ['留在原地', '搬到新城市', '远程工作两地生活'],
          constraints: ['预算不超过每月1万', '不影响孩子教育'],
          context: { currentCity: '北京', targetCity: '成都' },
        },
      });
      assert.equal(createRes.statusCode, 200);
      const { id: decisionId } = JSON.parse(createRes.body).data;

      /* 2. 运行模拟 */
      const simRes = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/simulate`,
      });
      assert.equal(simRes.statusCode, 200);
      const { runId, result } = JSON.parse(simRes.body).data;

      assert.equal(result.rankedOptions.length, 3);
      assert.ok(result.recommendedAlternative);
      /* 排名有序 */
      for (let i = 0; i < result.rankedOptions.length; i++) {
        assert.equal(result.rankedOptions[i].rank, i + 1);
      }
      /* 每个选项有解释 */
      for (const opt of result.rankedOptions) {
        assert.ok(opt.explanation.summary);
      }

      /* 3. 查看结果 */
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/decisions/${decisionId}/runs/${runId}`,
      });
      assert.equal(getRes.statusCode, 200);
      assert.deepEqual(JSON.parse(getRes.body).data.result, result);

      /* 4. 提交反馈 */
      const fbRes = await app.inject({
        method: 'POST',
        url: `/api/v1/decisions/${decisionId}/feedback`,
        payload: {
          runId,
          selectedAlternative: result.recommendedAlternative,
          satisfaction: 0.9,
          notes: '推荐结果符合预期',
        },
      });
      assert.equal(fbRes.statusCode, 200);
      assert.equal(JSON.parse(fbRes.body).data.stored, true);
    });
  });
});
