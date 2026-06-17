import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('引导 API 集成测试', () => {
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
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  describe('POST /api/v1/onboarding/start', () => {
    it('创建引导会话', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/start',
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.data.id.startsWith('onb_'));
      assert.equal(body.data.currentStep, 1);
    });
  });

  describe('GET /api/v1/onboarding/status/:sessionId', () => {
    it('获取会话状态', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/v1/onboarding/start' });
      const { id } = JSON.parse(createRes.body).data;

      const res = await app.inject({ method: 'GET', url: `/api/v1/onboarding/status/${id}` });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).data.id, id);
    });

    it('不存在的会话返回 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/onboarding/status/onb_nonexistent' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /api/v1/onboarding/step/:step', () => {
    it('Step 1: 提交决策问题', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/v1/onboarding/start' });
      const { id } = JSON.parse(createRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/1?sessionId=${id}`,
        payload: { title: '测试决策', description: '测试描述' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.decision);
      assert.equal(body.data.currentStep, 2);
    });

    it('Step 2: 提交价值选择', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/v1/onboarding/start' });
      const { id } = JSON.parse(createRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/2?sessionId=${id}`,
        payload: { values: ['诚信', '勇气', '创造力'] },
      });
      assert.equal(res.statusCode, 200);
    });

    it('Step 3: 提交记忆种子', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/v1/onboarding/start' });
      const { id } = JSON.parse(createRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/3?sessionId=${id}`,
        payload: { memories: [{ description: '创业经历' }, { description: '志愿者活动' }] },
      });
      assert.equal(res.statusCode, 200);
    });

    it('缺少 sessionId 返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/step/1',
        payload: { title: '测试', description: '描述' },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('POST /api/v1/onboarding/questionnaire', () => {
    it('提交问卷返回推断参数', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/questionnaire',
        payload: {
          responses: [
            { id: 'q_risk_1', score: 4 },
            { id: 'q_time_1', score: 5 },
            { id: 'q_growth_1', score: 3 },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.decisionStyle);
      assert.ok(body.data.cognitiveModel);
    });

    it('空 responses 返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/questionnaire',
        payload: { responses: [] },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('性格原型选择（②原型接入 onboarding/API）', () => {
    it('GET /api/v1/onboarding/archetypes 列出 4 个原型 + 画像', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/onboarding/archetypes' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 4, '应有 4 个原型');
      const archetypes = body.data.map((p: { archetype: string }) => p.archetype).sort();
      assert.deepEqual(archetypes, ['analyst', 'doer', 'explorer', 'guardian']);
      /* 每个原型应带中文 label + 描述（供 UI 渲染）+ 稳定 i18n key（供多语言前端本地化）。 */
      for (const p of body.data) {
        assert.ok(p.label && p.description, `原型 ${p.archetype} 应有 label + description`);
        assert.equal(p.labelI18nKey, `onboarding.archetype.${p.archetype}.label`, 'label i18n key 应稳定');
        assert.equal(p.descriptionI18nKey, `onboarding.archetype.${p.archetype}.description`, 'desc i18n key 应稳定');
      }
    });

    it('POST /api/v1/onboarding/archetype 用 guardian 出生 → 决策风格匹配守护者种子', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/archetype',
        payload: { archetype: 'guardian' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.archetype, 'guardian');
      /* 守护者：低风险、高损失厌恶、深思（与 ARCHETYPE_SEEDS.guardian 一致）。 */
      assert.equal(body.data.decisionStyle.riskAppetite, 0.2);
      assert.equal(body.data.decisionStyle.lossAversion, 3.0);
      assert.equal(body.data.decisionStyle.deliberationDepth, 4);
    });

    it('POST /api/v1/onboarding/archetype 非法原型返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/archetype',
        payload: { archetype: 'wizard' },
      });
      assert.equal(res.statusCode, 400, '非法原型应被 schema 拒绝');
    });
  });

  describe('POST /api/v1/onboarding/import', () => {
    it('导入日记条目', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/import',
        payload: {
          journalEntries: [
            { content: '今天很开心', valence: 0.8, salience: 0.5 },
            { content: '完成了项目' },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.journal.imported, 2);
    });

    it('导入决策记录', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/onboarding/import',
        payload: {
          decisionRecords: [
            { title: '职业选择', description: '换工作', outcome: '成功' },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.decisions.imported, 1);
    });
  });

  describe('端到端引导流程', () => {
    it('Start → Step1 → Step2 → Step3 → Step4 → Step5', async () => {
      /* 1. 创建会话 */
      const startRes = await app.inject({ method: 'POST', url: '/api/v1/onboarding/start' });
      const { id } = JSON.parse(startRes.body).data;

      /* 2. Step 1: 决策问题 */
      await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/1?sessionId=${id}`,
        payload: { title: '搬家决策', description: '是否搬到新城市' },
      });

      /* 3. Step 2: 价值选择 */
      await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/2?sessionId=${id}`,
        payload: { values: ['家庭', '成长', '稳定', '自由', '健康'] },
      });

      /* 4. Step 3: 记忆种子 */
      await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/3?sessionId=${id}`,
        payload: { memories: [{ description: '大学毕业时的搬迁经历', valence: 0.6 }] },
      });

      /* 5. Step 4: 运行模拟 */
      const simRes = await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/4?sessionId=${id}`,
      });
      assert.equal(simRes.statusCode, 200);
      const simBody = JSON.parse(simRes.body);
      assert.ok(simBody.data.simulationResult);

      /* 6. Step 5: 保存基线 */
      const saveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/onboarding/step/5?sessionId=${id}`,
      });
      assert.equal(saveRes.statusCode, 200);
      const saveBody = JSON.parse(saveRes.body);
      assert.ok(saveBody.data.snapshotId);

      /* 7. 验证最终状态 */
      const statusRes = await app.inject({ method: 'GET', url: `/api/v1/onboarding/status/${id}` });
      const finalSession = JSON.parse(statusRes.body).data;
      assert.equal(finalSession.completedSteps.length, 5);
      assert.ok(finalSession.snapshotId);
    });
  });
});
