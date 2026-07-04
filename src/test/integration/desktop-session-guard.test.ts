/**
 * 集成测试：桌面 sidecar 本地握手 guard（ADR-0061 S2 红线 11）。
 *
 * 验证 desktop 模式（CHRONO_DESKTOP_SESSION 存在）下：非 public 端点须带正确 X-Chrono-Desktop-Session 头，
 * 否则 403（loopback≠鉴权边界，挡同机其他进程/误连）；public 运维端点（healthz/readyz）豁免；
 * 非 desktop 模式（env 未设）→ guard no-op（向后兼容）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { registerDesktopSession } from '../../server/plugins/desktop-session.js';
import { registerErrorHandler } from '../../server/plugins/error-handler.js';

const TOKEN = 'test-handshake-token-abc123';

async function buildApp(): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const app = fastify();
  registerErrorHandler(app);
  registerDesktopSession(app); /* 读 process.env.CHRONO_DESKTOP_SESSION（beforeEach 设） */
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ status: 'ok' }));
  app.get('/api/v1/some-business', async () => ({ data: 'secret' }));
  await app.ready();
  return app;
}

describe('桌面 sidecar 本地握手 guard（ADR-0061 S2 红线 11）', () => {
  let app: FastifyInstance;
  const prev = process.env.CHRONO_DESKTOP_SESSION;

  afterEach(async () => {
    if (app) await app.close();
    if (prev === undefined) delete process.env.CHRONO_DESKTOP_SESSION;
    else process.env.CHRONO_DESKTOP_SESSION = prev;
  });

  describe('desktop 模式（CHRONO_DESKTOP_SESSION 已设）', () => {
    beforeEach(async () => {
      process.env.CHRONO_DESKTOP_SESSION = TOKEN;
      app = await buildApp();
    });

    it('★业务端点带正确握手头 → 放行★', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/some-business', headers: { 'x-chrono-desktop-session': TOKEN } });
      assert.equal(res.statusCode, 200, res.body);
    });

    it('★业务端点缺握手头 → 403（挡同机其他进程/误连）★', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/some-business' });
      assert.equal(res.statusCode, 403, res.body);
      assert.match(res.json().code, /DESKTOP_SESSION/);
    });

    it('★业务端点握手头错误 → 403★', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/some-business', headers: { 'x-chrono-desktop-session': 'wrong-token' } });
      assert.equal(res.statusCode, 403, res.body);
    });

    it('public 运维端点（healthz/readyz）豁免（父进程健康探测无需 token）', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
    });

    it('OPTIONS 预检豁免', async () => {
      const res = await app.inject({ method: 'OPTIONS', url: '/api/v1/some-business' });
      assert.notEqual(res.statusCode, 403);
    });
  });

  describe('非 desktop 模式（env 未设）→ guard no-op（向后兼容）', () => {
    beforeEach(async () => {
      delete process.env.CHRONO_DESKTOP_SESSION;
      app = await buildApp();
    });

    it('业务端点无握手头也放行（普通服务器/容器部署不受影响）', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/some-business' });
      assert.equal(res.statusCode, 200, res.body);
    });
  });
});
