/**
 * 审计 Warning #14 回归：Avatar autorun 端点必须校验**租户内**的分身归属。
 *
 * ## 缺陷
 *
 * `avatar-autorun.ts` 的 7 个端点此前只用 `request.tenantId`，不校验调用者是否拥有该 avatar。
 * 同一租户下的 user-1 拿 user-2 的 avatarId 即可读写其自动运行配置 —— 实测（修复前）：
 *
 *   GET  /avatars/:id/autorun       → 200（读到他人配置）
 *   GET  /avatars/:id/autorun/runs  → 200（读到他人运行历史）
 *   PUT  /avatars/:id/autorun       → 200 **且真的改掉了受害者的配置**
 *
 * 而同目录的 `avatars.ts` 早有 `requireOwnedAvatar`，普通 CRUD 对同一 ID 正确返回 404。
 * 也就是说 autorun 这组端点是**绕过既有守卫的旁路**。
 *
 * ## ⚠️ 本文件必须同时钉死「没有过度修正」
 *
 * 只断言「攻击者被挡」是不够的 —— 把所有人都挡掉，那条断言同样会通过。
 * 故必须同时断言：**owner 自己仍然可读可写**。
 *
 * ## 为什么直接签发 JWT 而不走注册/登录
 *
 * `register` 每次都新建租户（`tenant_${randomUUID()}`），拿不到「同租户第二个用户」；
 * 而 `login` 依赖 email 目录表。被测命题是**路由的授权**，不是登录链路，
 * 故直接用 `app.jwt.sign` 造一个同租户、不同 `sub` 的调用者，隔离被测面。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';

describe('审计 W#14 — Avatar autorun 租户内归属校验', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let ownerAuth: Record<string, string>;
  let attackerAuth: Record<string, string>;
  let avatarId: string;

  before(async () => {
    const config = loadConfig({
      rateLimit: { max: 10_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: 'x'.repeat(40), issuer: 'test' },
    });
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });

    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'autorun-owner@test.com', password: 'password123' },
    });
    assert.ok(reg.statusCode >= 200 && reg.statusCode < 300, `register: ${reg.statusCode} ${reg.body}`);
    const accessToken = JSON.parse(reg.body).data.accessToken as string;
    ownerAuth = { authorization: `Bearer ${accessToken}` };

    const claims = JSON.parse(
      Buffer.from(accessToken.split('.')[1] as string, 'base64').toString(),
    ) as { tenantId: string; sub: string };

    const created = await app.inject({
      method: 'POST', url: '/api/v1/avatars', headers: ownerAuth,
      payload: { label: 'owner-avatar', kind: 'work' },
    });
    assert.ok(created.statusCode >= 200 && created.statusCode < 300, `create avatar: ${created.body}`);
    avatarId = JSON.parse(created.body).data.id as string;

    const upserted = await app.inject({
      method: 'PUT', url: `/api/v1/avatars/${avatarId}/autorun`, headers: ownerAuth,
      payload: {
        enabled: true, intervalMinutes: 60, driftThreshold: 0.5,
        reviewRequired: false, knowledgeSourceIds: [],
      },
    });
    assert.ok(upserted.statusCode >= 200 && upserted.statusCode < 300, `upsert autorun: ${upserted.body}`);

    /* ⚠️ 攻击者必须是一个**有真实 identity 的合法同租户用户**。
     * 初版只签了 JWT、没建 identity 行 —— 于是请求在 `identityService.getByUser` 处
     * 就被「身份不存在」挡掉，**根本走不到分身归属那一步**。变异实测拆穿了这一点：
     * 把归属校验整个删掉，那版用例**仍然全绿**（它证明的是「无身份用户被拒」，
     * 而不是「归属校验有效」）。故此处补建 user + identity。 */
    const db = os.getDatabase();
    const ts = Date.now();
    db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user_attacker', 'autorun-attacker@test.com', 'hash', 'member', claims.tenantId, ts, ts);
    db.prepare<void>(
      `INSERT INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ident_attacker', 'user_attacker', claims.tenantId, 'Attacker', ts, ts);

    /* 同租户、不同用户的攻击者。 */
    /* 签发方式与 organizations-api.test.ts 同款：iat/exp 由 fastify-jwt 补齐，
     * 故用 Record<string, unknown> 签名（JwtPayload 要求 iat/exp 必填，那是**校验**侧的形状）。 */
    const attackerToken = (app as FastifyInstance & {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: 'user_attacker', tenantId: claims.tenantId, role: 'member', planId: 'free',
    });
    attackerAuth = { authorization: `Bearer ${attackerToken}` };
  });

  after(async () => { await app.close(); os.close(); });

  it('同租户的他人不得读取 autorun 配置 / 运行历史 / 漂移（修复前均 200）', async () => {
    for (const url of [
      `/api/v1/avatars/${avatarId}/autorun`,
      `/api/v1/avatars/${avatarId}/autorun/runs`,
      `/api/v1/avatars/${avatarId}/drift`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: attackerAuth });
      assert.equal(res.statusCode, 404, `${url} 应 404（与 avatars.ts 同款：不泄露存在性），实际 ${res.statusCode}`);
    }
  });

  it('同租户的他人不得写 autorun 配置（修复前 200 且真的改掉了受害者配置）', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/avatars/${avatarId}/autorun`, headers: attackerAuth,
      payload: {
        enabled: false, intervalMinutes: 15, driftThreshold: 0.1,
        reviewRequired: false, knowledgeSourceIds: [],
      },
    });
    assert.equal(res.statusCode, 404, `攻击者写入应 404，实际 ${res.statusCode}: ${res.body}`);

    /* 钉死「没被改掉」——只断言状态码不够，写入可能已落库。 */
    const reread = await app.inject({
      method: 'GET', url: `/api/v1/avatars/${avatarId}/autorun`, headers: ownerAuth,
    });
    const cfg = JSON.parse(reread.body).data as { enabled: boolean; intervalMinutes: number };
    assert.equal(cfg.enabled, true, 'owner 的配置不得被他人改动');
    assert.equal(cfg.intervalMinutes, 60, 'owner 的配置不得被他人改动');
  });

  it('同租户的他人不得触发运行', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/avatars/${avatarId}/autorun/trigger`,
      headers: attackerAuth, payload: {},
    });
    assert.equal(res.statusCode, 404, `攻击者触发应 404，实际 ${res.statusCode}`);
  });

  it('⚠️ 对照：owner 本人所有端点仍然可用（防「谁都挡」的假修复）', async () => {
    for (const url of [
      `/api/v1/avatars/${avatarId}/autorun`,
      `/api/v1/avatars/${avatarId}/autorun/runs`,
      `/api/v1/avatars/${avatarId}/drift`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: ownerAuth });
      assert.ok(res.statusCode < 400, `owner GET ${url} 应成功，实际 ${res.statusCode}`);
    }

    const write = await app.inject({
      method: 'PUT', url: `/api/v1/avatars/${avatarId}/autorun`, headers: ownerAuth,
      payload: {
        enabled: true, intervalMinutes: 30, driftThreshold: 0.4,
        reviewRequired: false, knowledgeSourceIds: [],
      },
    });
    assert.ok(write.statusCode < 400, `owner PUT 应成功，实际 ${write.statusCode}: ${write.body}`);

    const trigger = await app.inject({
      method: 'POST', url: `/api/v1/avatars/${avatarId}/autorun/trigger`,
      headers: ownerAuth, payload: {},
    });
    assert.ok(trigger.statusCode < 400, `owner trigger 应成功，实际 ${trigger.statusCode}`);
  });
});
