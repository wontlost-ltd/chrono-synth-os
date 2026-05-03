/**
 * 极限吞吐量测试
 *
 * 使用 app.inject() 测量本机最大吞吐量，无网络栈开销，结果代表纯处理能力上限。
 *
 * 硬编码路由限流约束（不可通过配置覆盖）：
 *   - POST /api/v1/auth/*        max=5/IP/min
 *   - POST /api/v1/memories      max=30/IP/min
 *   - POST /api/v1/decisions     max=30/IP/min
 *   - POST /api/v1/knowledge-sources max=30/IP/min
 *
 * 测试策略：
 *   - 读路由（GET /healthz 等）：高并发无限制，测纯吞吐
 *   - 写路由：每个测试用例独立 os/app/db，配额计数器归零
 *     或通过多租户分散写压到各自配额窗口
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';

// ── 配置 ────────────────────────────────────────────────────────────────────

const JWT_SECRET = 'load-test-secret-at-least-32-characters!';

const BASE_CONFIG = {
  rateLimit: { max: 10_000_000, timeWindowMs: 60_000 },
  websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
  jwt: { enabled: true, secret: JWT_SECRET, issuer: 'load-test' },
};

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

interface Stats {
  count: number; wallMs: number; rps: number;
  p50: number; p90: number; p99: number; min: number; max: number;
}

function calcStats(durations: number[], wallMs: number): Stats {
  const s = [...durations].sort((a, b) => a - b);
  return {
    count: durations.length,
    wallMs: Math.round(wallMs),
    rps: Math.round((durations.length / wallMs) * 1000),
    p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99),
    min: s[0], max: s[s.length - 1],
  };
}

function report(label: string, s: Stats): void {
  console.log(
    `\n  ┌─ ${label}\n` +
    `  │  count=${s.count}  rps=${s.rps}  wall=${s.wallMs}ms\n` +
    `  │  min=${s.min}ms  p50=${s.p50}ms  p90=${s.p90}ms  p99=${s.p99}ms  max=${s.max}ms\n` +
    `  └─`,
  );
}

/** 创建独立 app 实例，注册一个用户，预热，然后执行测试函数 */
async function withApp(
  fn: (app: FastifyInstance, token: string, tenantId: string) => Promise<void>,
): Promise<void> {
  const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
  os.start();
  const db: IDatabase = os.getDatabase();
  const app = await createApp({ os, config: loadConfig(BASE_CONFIG), db });

  // auth has hardcoded max=5/IP — this is the 1st of 5 slots
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { email: `lt_${Date.now()}@test.local`, password: 'password123' },
  });
  assert.ok(reg.statusCode === 200 || reg.statusCode === 201, `setup register failed: ${reg.body}`);
  const { accessToken, tenantId } = (JSON.parse(reg.body) as { data: { accessToken: string; tenantId: string } }).data;

  for (let i = 0; i < 20; i++) await app.inject({ method: 'GET', url: '/healthz' });

  try {
    await fn(app, accessToken, tenantId);
  } finally {
    os.close();
  }
}

async function runConcurrent(
  fn: (i: number) => Promise<number>,
  concurrency: number,
  total: number,
): Promise<number[]> {
  const durations: number[] = [];
  let dispatched = 0;
  async function worker(): Promise<void> {
    while (dispatched < total) {
      const idx = dispatched++;
      durations.push(await fn(idx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return durations;
}

// ── 测试用例 ──────────────────────────────────────────────────────────────────

describe('极限吞吐量测试', () => {

  // ── 1. 健康检查基线（串行）────────────────────────────────────────────────

  it('基线：GET /healthz 串行 500 次', async () => {
    await withApp(async (app) => {
      const durations: number[] = [];
      const wall0 = performance.now();
      for (let i = 0; i < 500; i++) {
        const t = performance.now();
        const res = await app.inject({ method: 'GET', url: '/healthz' });
        assert.equal(res.statusCode, 200);
        durations.push(Math.round(performance.now() - t));
      }
      const s = calcStats(durations, performance.now() - wall0);
      report('GET /healthz 串行', s);
      assert.ok(s.rps >= 1_000, `串行 RPS ${s.rps} < 1000`);
      assert.ok(s.p99 <= 20, `p99 ${s.p99}ms > 20ms`);
    });
  });

  // ── 2. 健康检查并发 ───────────────────────────────────────────────────────

  it('并发：GET /healthz ×50 协程 ×500 请求', async () => {
    await withApp(async (app) => {
      const wall0 = performance.now();
      const durations = await runConcurrent(async () => {
        const t = performance.now();
        const res = await app.inject({ method: 'GET', url: '/healthz' });
        assert.equal(res.statusCode, 200);
        return Math.round(performance.now() - t);
      }, 50, 500);
      const s = calcStats(durations, performance.now() - wall0);
      report('GET /healthz ×50 并发', s);
      assert.ok(s.rps >= 2_000, `并发 RPS ${s.rps} < 2000`);
      assert.ok(s.p99 <= 50, `并发 p99 ${s.p99}ms > 50ms`);
    });
  });

  // ── 3. 持续压力（固定时间窗口最大 RPS）───────────────────────────────────

  it('持续压力：2000ms 窗口 ×50 协程 GET /healthz', async () => {
    await withApp(async (app) => {
      const WINDOW_MS = 2_000;
      const CONCURRENCY = 50;
      const deadline = Date.now() + WINDOW_MS;
      const durations: number[] = [];
      let errors = 0;

      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (Date.now() < deadline) {
          const t = performance.now();
          const res = await app.inject({ method: 'GET', url: '/healthz' });
          if (res.statusCode === 200) durations.push(Math.round(performance.now() - t));
          else errors++;
        }
      }));

      const s = calcStats(durations, WINDOW_MS);
      const errorRate = errors / (durations.length + errors);
      report(`持续压力 ×${CONCURRENCY} 协程 ${WINDOW_MS}ms`, s);
      console.log(`  │  errors=${errors}  error_rate=${(errorRate * 100).toFixed(2)}%`);

      assert.ok(errorRate < 0.01, `错误率 ${(errorRate * 100).toFixed(2)}% > 1%`);
      assert.ok(s.rps >= 2_000, `持续 RPS ${s.rps} < 2000`);
      assert.ok(s.p99 <= 100, `持续压力 p99 ${s.p99}ms > 100ms`);
    });
  });

  // ── 4. 写请求并发（memories，≤28/窗口内，留2槽给 setup）─────────────────
  // POST /api/v1/memories 硬编码 max=30/IP/min。
  // 每个 withApp 实例有独立计数器，setup 用了 0 个写槽（仅用了 auth 槽）。
  // 安全上限 28 并发，留 2 个余量。

  it('并发：POST /api/v1/memories ×10 协程 ×25 请求（≤30 限流）', async () => {
    await withApp(async (app, token, tenantId) => {
      const wall0 = performance.now();
      const durations = await runConcurrent(async (i) => {
        const t = performance.now();
        const res = await app.inject({
          method: 'POST', url: '/api/v1/memories',
          headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
          payload: {
            kind: (['episodic', 'semantic', 'procedural'] as const)[i % 3],
            content: `load memory ${i} ts=${Date.now()}`,
            valence: (i % 21 - 10) / 10,
            salience: (i % 11) / 10,
          },
        });
        assert.ok(res.statusCode === 200 || res.statusCode === 201,
          `memory ${i}: ${res.statusCode} ${res.body}`);
        return Math.round(performance.now() - t);
      }, 10, 25);
      const s = calcStats(durations, performance.now() - wall0);
      report('POST /api/v1/memories ×10 并发 ×25 请求', s);
      assert.ok(s.p99 <= 300, `写请求 p99 ${s.p99}ms > 300ms`);
      assert.ok(s.rps >= 100, `写请求 RPS ${s.rps} < 100`);
    });
  });

  // ── 5. 多租户扩展写（每租户独立计数器，绕过 per-IP 限流）────────────────
  // N 租户各自注册 → 各自写 25 条 memories → 总写量 = N×25，无限流碰撞。
  // auth 限流 max=5/IP 约束注册数，setup 已用 1 槽，最多再注册 4 个。

  it('多租户：4 租户各自并发写 25 条 memories（共 100 条）', async () => {
    await withApp(async (app) => {
      // 注册 4 个租户（加上 withApp 的 setup 注册，共消耗 auth 限流 5 槽）
      const tenants: Array<{ accessToken: string; tenantId: string }> = [];
      for (let i = 0; i < 4; i++) {
        const r = await app.inject({
          method: 'POST', url: '/api/v1/auth/register',
          payload: { email: `mt_${Date.now()}_${i}@test.local`, password: 'password123' },
        });
        assert.ok(r.statusCode === 200 || r.statusCode === 201, `tenant ${i} register: ${r.body}`);
        tenants.push((JSON.parse(r.body) as { data: { accessToken: string; tenantId: string } }).data);
      }

      // 每个租户独立计数器，各自并发写 25 条（总 100，全部安全）
      const wall0 = performance.now();
      const allDurations = (await Promise.all(
        tenants.map(({ accessToken, tenantId }) =>
          runConcurrent(async (i) => {
            const t = performance.now();
            const res = await app.inject({
              method: 'POST', url: '/api/v1/memories',
              headers: { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId },
              payload: { kind: 'semantic', content: `tenant mem ${i}`, valence: 0, salience: 0.5 },
            });
            assert.ok(res.statusCode === 200 || res.statusCode === 201, `write: ${res.body}`);
            return Math.round(performance.now() - t);
          }, 10, 25),
        ),
      )).flat();

      const s = calcStats(allDurations, performance.now() - wall0);
      report(`多租户 4×25 memories 并发`, s);
      assert.ok(s.p99 <= 300, `多租户 p99 ${s.p99}ms > 300ms`);
    });
  });

  // ── 6. 决策创建（max=30/IP/min，安全上限 25）──────────────────────────────

  it('决策：POST /api/v1/decisions ×10 协程 ×25 请求', async () => {
    await withApp(async (app, token, tenantId) => {
      const wall0 = performance.now();
      const durations = await runConcurrent(async (i) => {
        const t = performance.now();
        const res = await app.inject({
          method: 'POST', url: '/api/v1/decisions',
          headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
          payload: {
            title: `决策 ${i}`,
            description: `极限测试第 ${i} 个决策`,
            alternatives: [`方案A-${i}`, `方案B-${i}`, `方案C-${i}`],
          },
        });
        assert.ok(res.statusCode === 200 || res.statusCode === 201,
          `decision ${i}: ${res.statusCode} ${res.body}`);
        return Math.round(performance.now() - t);
      }, 10, 25);
      const s = calcStats(durations, performance.now() - wall0);
      report('POST /api/v1/decisions ×10 并发 ×25 请求', s);
      assert.ok(s.p99 <= 500, `决策 p99 ${s.p99}ms > 500ms`);
      assert.ok(s.rps >= 30, `决策 RPS ${s.rps} < 30`);
    });
  });

  // ── 7. 混合流量（读为主，少量写，总写量≤25）──────────────────────────────

  it('混合：GET /healthz ×200 + POST /api/v1/memories ×20，交错并发', async () => {
    await withApp(async (app, token, tenantId) => {
      const wall0 = performance.now();
      let writeCount = 0;
      const durations = await runConcurrent(async (i) => {
        const t = performance.now();
        // 前 200 次读，后 20 次写（共 220 请求，写不超过 25 配额）
        if (i < 200) {
          const res = await app.inject({ method: 'GET', url: '/healthz' });
          assert.equal(res.statusCode, 200, `read ${i}: ${res.statusCode}`);
        } else {
          writeCount++;
          const res = await app.inject({
            method: 'POST', url: '/api/v1/memories',
            headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
            payload: { kind: 'episodic', content: `mixed ${i}`, valence: 0, salience: 0.5 },
          });
          assert.ok(res.statusCode === 200 || res.statusCode === 201, `write ${i}: ${res.statusCode}`);
        }
        return Math.round(performance.now() - t);
      }, 20, 220);
      const s = calcStats(durations, performance.now() - wall0);
      report('混合 200读+20写 ×20 并发', s);
      assert.ok(s.p99 <= 300, `混合 p99 ${s.p99}ms > 300ms`);
    });
  });

  // ── 8. 冲突 pipeline（create→list→resolve，3步/轮，×20轮 = 60写槽，
  //    但 conflicts 路由使用全局限流，不受 memories 的 per-route 约束）────

  it('冲突：create→list→resolve pipeline ×10 并发 ×20 轮', async () => {
    await withApp(async (app, token, tenantId) => {
      const wall0 = performance.now();
      const durations = await runConcurrent(async (i) => {
        const conflictId = `lc_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const t = performance.now();

        const create = await app.inject({
          method: 'POST', url: '/api/v1/conflicts',
          headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
          payload: {
            schemaVersion: 'conflict-inbox.v1', conflictId, conflictVersion: 'v1',
            entityType: 'persona', entityId: `e_${i}`, sourceRuntime: 'web',
            detectedAt: new Date().toISOString(), severity: 'warning',
            localSummaryId: 'conflict.local.newer', localSummaryParams: {},
            serverSummaryId: 'conflict.server.different', serverSummaryParams: {},
            suggestedActions: ['keep_local', 'keep_server'], tenantId,
          },
        });
        assert.ok(create.statusCode === 200 || create.statusCode === 201,
          `create ${i}: ${create.body}`);

        const list = await app.inject({
          method: 'GET', url: '/api/v1/conflicts',
          headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
        });
        assert.equal(list.statusCode, 200);

        const resolve = await app.inject({
          method: 'POST', url: `/api/v1/conflicts/${conflictId}/resolve`,
          headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
          payload: { conflictId, ifMatch: 'v1', action: 'keep_local' },
        });
        assert.equal(resolve.statusCode, 200);

        return Math.round(performance.now() - t);
      }, 10, 20);
      const s = calcStats(durations, performance.now() - wall0);
      report('冲突 create→list→resolve ×10 并发 ×20 轮', s);
      assert.ok(s.p99 <= 600, `冲突 pipeline p99 ${s.p99}ms > 600ms`);
    });
  });

  // ── 9. 认证热路径（max=5/IP/min，setup 用 1 槽，剩余 4 轮） ──────────────

  it('认证：register+login 串行 4 轮（IP 限流预算内）', async () => {
    await withApp(async (app) => {
      const durations: number[] = [];
      for (let i = 0; i < 4; i++) {
        const email = `auth_lt_${Date.now()}_${i}@test.local`;
        const t = performance.now();
        const reg = await app.inject({
          method: 'POST', url: '/api/v1/auth/register',
          payload: { email, password: 'password123' },
        });
        assert.ok(reg.statusCode === 200 || reg.statusCode === 201, `register ${i}: ${reg.body}`);
        const login = await app.inject({
          method: 'POST', url: '/api/v1/auth/login',
          payload: { email, password: 'password123' },
        });
        assert.equal(login.statusCode, 200, `login ${i}: ${login.body}`);
        durations.push(Math.round(performance.now() - t));
      }
      const s = calcStats(durations, durations.reduce((a, b) => a + b, 0));
      report('register+login 往返 4 轮', s);
      assert.ok(s.p99 <= 500, `register+login p99 ${s.p99}ms > 500ms`);
    });
  });

  // ── 10. SQLite WAL 写并发扩展性（在 memories 配额内探测并发极限）─────────

  it('SQLite WAL 写并发：concurrency 1→10 扩展性', async () => {
    // 总写量 = sum(c * 3) for c in [1,2,5,10] = 3+6+15+30 = 54 > 30，
    // 所以每个 concurrency 级别用一个独立 app。
    const results: Array<{ concurrency: number; rps: number; p99: number }> = [];

    for (const c of [1, 2, 5, 10]) {
      await withApp(async (app, token, tenantId) => {
        const n = Math.min(c * 3, 25); // 每级别最多 25 写，绝对不超配额
        const wall0 = performance.now();
        const durations = await runConcurrent(async (i) => {
          const t = performance.now();
          const res = await app.inject({
            method: 'POST', url: '/api/v1/memories',
            headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
            payload: { kind: 'episodic', content: `wal c=${c} i=${i}`, valence: 0, salience: 0.5 },
          });
          assert.ok(res.statusCode === 200 || res.statusCode === 201,
            `c=${c} i=${i}: ${res.statusCode}`);
          return Math.round(performance.now() - t);
        }, c, n);
        const s = calcStats(durations, performance.now() - wall0);
        results.push({ concurrency: c, rps: s.rps, p99: s.p99 });
      });
    }

    console.log('\n  SQLite WAL 写并发扩展性:');
    for (const r of results) {
      console.log(`  │  c=${r.concurrency.toString().padEnd(3)}  rps=${r.rps.toString().padEnd(6)}  p99=${r.p99}ms`);
    }

    // Baseline: c=1 must be healthy
    assert.ok(results[0].p99 <= 100, `c=1 p99 ${results[0].p99}ms > 100ms`);
    // At any level, should still process requests
    assert.ok(results.every(r => r.rps > 0), 'All concurrency levels must produce non-zero RPS');
  });
});
