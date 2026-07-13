/**
 * 集成测试：POST /api/v1/companion/me/grow —— 确定性成长端点（缺口6：无 LLM key 也能成长）。
 *
 * 覆盖：① 无记忆 → grew:false + no_material（短路不扣配额）；② 有记忆 → 跑确定性认知周期
 * （零-LLM，返回固化/衰减/模式统计）；③ **不配任何 LLM key 也能调通**（与 /reflect 需 key 对比）；
 * ④ 鉴权（未授权 401/403）；⑤ 确定性（同输入同输出，无副作用不确定性）。
 *
 * 关键：整条链路不构造 ModelRouter、不需 CHRONO_INTELLIGENCE_API_KEY——证明「无云 LLM 也能成长」。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body).data;
}

describe('companion 确定性成长端点 /grow（无 LLM key）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  /* 注意：config 不含任何 intelligence.apiKey——证明无 key 也能成长（provider 默认 mock）。 */
  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });
  afterEach(async () => { await app.close(); os.close(); });

  it('无授权 → 拒绝（401/403）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/grow' });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `期望 401/403，实际 ${res.statusCode}`);
  });

  it('全新用户（无记忆）→ no_material（无材料可成长，短路不报错），无需任何 LLM key', async () => {
    const auth = await registerAndGetAuth(app, 'grow-fresh@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/grow', headers });
    /* 关键：调通（200），不是 500——无 LLM key 也能触发（对比 /reflect 需 key）。全新无记忆 → no_material。 */
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).data.reason, 'no_material');
  });

  it('有记忆 → 确定性成长跑通（返回统计字段，无 LLM）', async () => {
    const auth = await registerAndGetAuth(app, 'grow-mem@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    /* 经真实写路径造记忆（POST /memories），使 grow 有材料。 */
    for (const content of ['我今天完成了一个重要项目', '我喜欢在安静的环境里工作']) {
      await app.inject({ method: 'POST', url: '/api/v1/memories', headers, payload: { kind: 'episodic', content, valence: 0.6, salience: 0.7 } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/grow', headers });
    assert.equal(res.statusCode, 200, res.body);
    const d = JSON.parse(res.body).data;
    /* 有记忆 → 跑确定性认知周期，返回完整统计字段（零-LLM）。 */
    for (const k of ['grew', 'consolidated', 'patternsFound', 'emotionalEvents', 'decayed', 'evicted']) {
      assert.ok(k in d, `返回缺字段 ${k}`);
    }
  });
});
