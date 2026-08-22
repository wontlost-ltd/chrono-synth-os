/**
 * 审计 P2 回归：onboarding v2 的 HTTP 端点必须真的能跑通。
 *
 * ⚠️ 为什么需要这个文件：`/api/v1/onboarding/v2/agent` 此前**每次调用必 500** ——
 * 它往 `persona_versions` 插 14 列，而该表只有 9 列，实测报
 * `table persona_versions has no column named persona_id`。
 *
 * 而它在**完整测试套件全绿**的情况下坏了很久，因为：
 *   - `onboarding-v2-service.test.ts` 只测 service 层（那条 INSERT 在 route 层）；
 *   - 没有任何测试打过这些 HTTP 端点。
 *
 * 教训：坏在哪一层，就得在哪一层测。service 全绿证明不了 route 能用。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

const JWT_SECRET = 'onboarding-v2-http-secret-at-least-32-chars';

describe('审计 P2 — onboarding v2 HTTP 端点', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let token: string;

  before(async () => {
    const config = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    });
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });

    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'onboarding-v2@test.com', password: 'password123' },
    });
    assert.ok(reg.statusCode >= 200 && reg.statusCode < 300, `register: ${reg.statusCode} ${reg.body}`);
    token = JSON.parse(reg.body).data.accessToken as string;
  });

  after(async () => { await app.close(); os.close(); });

  it('start → organization → agent 三步链路全部 2xx（agent 步曾必 500）', async () => {
    const auth = { authorization: `Bearer ${token}` };

    const start = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/v2/start', headers: auth, payload: {},
    });
    assert.ok(start.statusCode >= 200 && start.statusCode < 300,
      `start 应 2xx，实际 ${start.statusCode}: ${start.body}`);
    const sessionId = JSON.parse(start.body).data.id as string;
    assert.ok(sessionId, 'start 应返回 session id');

    const org = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/v2/organization', headers: auth,
      payload: { sessionId, organizationName: 'Acme' },
    });
    assert.ok(org.statusCode >= 200 && org.statusCode < 300,
      `organization 应 2xx，实际 ${org.statusCode}: ${org.body}`);

    /* 核心断言：这一步此前 500（persona_versions 列不存在）。 */
    const agent = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/v2/agent', headers: auth,
      payload: { sessionId, agentName: 'My Agent' },
    });
    assert.ok(agent.statusCode >= 200 && agent.statusCode < 300,
      `agent 应 2xx，实际 ${agent.statusCode}: ${agent.body}`);
    const agentId = JSON.parse(agent.body).data.agentId as string;
    assert.ok(agentId?.startsWith('agent_'), `应返回 agentId，实际 ${agent.body}`);
  });

  it('agent 步幂等：重复调用返回同一个 agentId', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const start = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/v2/start', headers: auth, payload: {},
    });
    const sessionId = JSON.parse(start.body).data.id as string;

    const first = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/v2/agent', headers: auth,
      payload: { sessionId, agentName: 'Idem Agent' },
    });
    assert.ok(first.statusCode >= 200 && first.statusCode < 300, `首次: ${first.body}`);
    const firstId = JSON.parse(first.body).data.agentId as string;

    const second = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/v2/agent', headers: auth,
      payload: { sessionId, agentName: 'Idem Agent' },
    });
    assert.ok(second.statusCode >= 200 && second.statusCode < 300, `二次: ${second.body}`);
    assert.equal(JSON.parse(second.body).data.agentId, firstId, '重复调用应复用同一 agentId');
  });
});
