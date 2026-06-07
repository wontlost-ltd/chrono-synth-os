/**
 * 集成测试：MCP HTTP 端点 + 工具权限闸门 + 5 个内置工具
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type FastifyInstance } from 'fastify';
import { createApp } from '../../server/index.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';
import { loadConfig } from '../../config/schema.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';

describe('MCP API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let accessToken: string;
  let userId: string;
  let tenantId: string;
  let personaId: string;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: {
      enabled: true,
      secret: 'test-secret-32-chars-minimum!!!!!',
      accessTtlMs: 3600_000,
      refreshTtlMs: 86400_000,
    },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'mcp-test@example.com', password: 'password123' },
    });
    const regBody = JSON.parse(regRes.body);
    accessToken = regBody.data.accessToken;
    userId = regBody.data.userId;
    tenantId = regBody.data.tenantId;

    /* 创建 persona */
    const personaCoreService = new PersonaCoreService(os.getDatabase());
    const persona = personaCoreService.createPersona({
      tenantId,
      ownerUserId: userId,
      displayName: 'MCP Test Persona',
    });
    personaId = persona.id;
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  /* ── 能力发现 ──────────────────────────────────────────────────── */

  it('GET /api/v1/mcp/capabilities 返回协议版本 + 服务信息', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/mcp/capabilities' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.protocolVersion, '2024-11-05');
    assert.equal(body.serverInfo.name, 'chrono-synth-os');
    assert.equal(body.transport, 'http+jsonrpc');
  });

  /* ── 鉴权 ──────────────────────────────────────────────────────── */

  it('POST /api/v1/mcp 缺少 Bearer 时返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/v1/mcp 无效 JSON-RPC 信封返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { jsonrpc: '1.0', method: 'ping' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, -32600);
  });

  /* ── initialize / ping ─────────────────────────────────────────── */

  it('initialize 返回服务能力', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1.0' }, capabilities: {} },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.result.protocolVersion, '2024-11-05');
    assert.ok(body.result.capabilities.tools);
  });

  it('ping 返回空 result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.result, {});
  });

  /* ── tools/list ────────────────────────────────────────────────── */

  it('tools/list 返回所有内置工具', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const names = body.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('persona.get_context'));
    assert.ok(names.includes('memory.search'));
    assert.ok(names.includes('memory.add'));
    assert.ok(names.includes('knowledge.query'));
    assert.ok(names.includes('decision.record'));
  });

  /* ── tools/call 权限闸门 ────────────────────────────────────────── */

  it('tools/call 没有 agency authorization → permission_denied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, -32002); // MCP_ERROR_PERMISSION_DENIED
    assert.match(body.error.message, /代理授权书/);
  });

  it('tools/call 有 agency 但无 permission → permission_denied', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Test broad delegation for MCP integration tests',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, -32002);
  });

  it('tools/call 完整路径成功：agency + permission → 返回 result', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Full delegation for MCP testing scenarios',
    });
    perm.grant({
      tenantId, personaId, toolId: 'persona.get_context',
      scope: 'read', constraints: {}, grantedBy: userId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.result);
    assert.equal(body.result.content.length, 1);
    assert.equal(body.result.content[0].type, 'json');
    assert.equal(body.result.content[0].json.personaId, personaId);
  });

  it('tools/call 配额耗尽 → quota_exceeded', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Quota exhaustion test scenario',
    });
    perm.grant({
      tenantId, personaId, toolId: 'persona.get_context',
      scope: 'read',
      constraints: { maxActionsPerDay: 1 },
      grantedBy: userId,
    });

    /* 第一次成功，吃掉配额 */
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });
    assert.equal(JSON.parse(r1.body).result?.content?.length, 1);

    /* 第二次应被 quota 拒绝 */
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });
    const body2 = JSON.parse(r2.body);
    assert.equal(body2.error.code, -32003); // MCP_ERROR_QUOTA_EXCEEDED
  });

  it('tools/call 撤销后立即生效（不缓存）', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Revocation immediacy test',
    });
    const grant = perm.grant({
      tenantId, personaId, toolId: 'persona.get_context',
      scope: 'read', constraints: {}, grantedBy: userId,
    });

    /* 撤销 */
    perm.revoke(grant.id, 'test revocation');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, -32002);
    assert.match(body.error.message, /revoked/);
  });

  it('tools/call memory.add 写入并返回 memoryId', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Memory add integration test scope',
    });
    perm.grant({
      tenantId, personaId, toolId: 'memory.add',
      scope: 'write', constraints: {}, grantedBy: userId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        personaId,
        params: {
          name: 'memory.add',
          arguments: {
            ownerUserId: userId,
            kind: 'knowledge',
            summary: 'External LLM observation: user prefers async meetings',
            importance: 0.6,
          },
        },
      },
    });
    const body = JSON.parse(res.body);
    assert.ok(body.result);
    assert.ok(body.result.content[0].json.memoryId.startsWith('pmem_') || body.result.content[0].json.memoryId.length > 0);
  });

  it('未知工具 → tool_not_found', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Unknown tool test',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        personaId,
        params: { name: 'no.such.tool', arguments: {} },
      },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, -32004); // MCP_ERROR_TOOL_NOT_FOUND
  });

  it('tools/call 缺 personaId 字段 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'persona.get_context', arguments: {} },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  /* ── 调用历史审计 ──────────────────────────────────────────────── */

  /* ── 二次确认 flow（P3-C5）────────────────────────────────────── */

  it('高风险工具首次调用返回 confirmation_required + token', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'High-risk tool confirmation flow test',
    });
    perm.grant({
      tenantId, personaId, toolId: 'calendar',
      scope: 'execute', constraints: {}, grantedBy: userId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 100, method: 'tools/call',
        personaId,
        params: {
          name: 'calendar',
          arguments: { action: 'create', calendarId: 'primary', event: { summary: 'Team meeting' } },
        },
      },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, -32005); // MCP_ERROR_CONFIRMATION_REQUIRED
    assert.ok(body.error.data.confirmationTokenId);
    assert.ok(body.error.data.confirmationTokenId.startsWith('cct_'));
  });

  it('携带相同参数的 confirmationToken 第二次调用成功', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Confirmation token consume test',
    });
    perm.grant({
      tenantId, personaId, toolId: 'calendar',
      scope: 'execute', constraints: {}, grantedBy: userId,
    });

    const args = { action: 'list', calendarId: 'primary' };
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 101, method: 'tools/call',
        personaId,
        params: { name: 'calendar', arguments: args },
      },
    });
    const tokenId = JSON.parse(r1.body).error.data.confirmationTokenId;

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 102, method: 'tools/call',
        personaId,
        params: { name: 'calendar', arguments: args, confirmationToken: tokenId },
      },
    });
    const body2 = JSON.parse(r2.body);
    assert.ok(body2.result, `Expected success result, got error: ${JSON.stringify(body2.error)}`);
    assert.equal((body2.result.content[0] as { json: { mock: boolean } }).json.mock, true);
  });

  it('不同参数的调用复用 confirmationToken 失败（input_changed）', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Confirmation token mismatch test',
    });
    perm.grant({
      tenantId, personaId, toolId: 'calendar',
      scope: 'execute', constraints: {}, grantedBy: userId,
    });

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 103, method: 'tools/call',
        personaId,
        params: { name: 'calendar', arguments: { action: 'list' } },
      },
    });
    const tokenId = JSON.parse(r1.body).error.data.confirmationTokenId;

    /* 第二次用不同参数 → token 校验失败 */
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 104, method: 'tools/call',
        personaId,
        params: {
          name: 'calendar',
          arguments: { action: 'list', calendarId: 'different' },
          confirmationToken: tokenId,
        },
      },
    });
    const body2 = JSON.parse(r2.body);
    assert.equal(body2.error.code, -32002); // permission_denied (token invalid)
    assert.match(body2.error.message, /token/);
  });

  /* ── 外部工具：mock provider 走完整路径 ────────────────────────── */

  it('web_search mock provider 完整路径', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'research', scopeDescription: 'Research tool integration test',
    });
    perm.grant({
      tenantId, personaId, toolId: 'web_search',
      scope: 'read', constraints: {}, grantedBy: userId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 200, method: 'tools/call',
        personaId,
        params: { name: 'web_search', arguments: { query: 'test', topK: 3 } },
      },
    });
    const body = JSON.parse(res.body);
    assert.ok(body.result);
    const json = (body.result.content[0] as { json: { results: unknown[] } }).json;
    assert.ok(Array.isArray(json.results));
  });

  it('email.send dryRun mode 返回 dryRun 结构（高风险流程）', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'communication', scopeDescription: 'Email integration test',
    });
    perm.grant({
      tenantId, personaId, toolId: 'email.send',
      scope: 'execute', constraints: {}, grantedBy: userId,
    });

    /* 第一次：高风险，返回 confirmation_required */
    const args = { to: 'someone@example.com', subject: 'Hi', bodyText: 'Hello there' };
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 300, method: 'tools/call',
        personaId,
        params: { name: 'email.send', arguments: args },
      },
    });
    const tokenId = JSON.parse(r1.body).error.data.confirmationTokenId;

    /* 第二次：携带 token 真正发出（mock 模式自动 dryRun） */
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 301, method: 'tools/call',
        personaId,
        params: { name: 'email.send', arguments: args, confirmationToken: tokenId },
      },
    });
    const body2 = JSON.parse(r2.body);
    assert.ok(body2.result);
    const json = (body2.result.content[0] as { json: { dryRun: boolean; to: string } }).json;
    assert.equal(json.dryRun, true);
    assert.equal(json.to, 'someone@example.com');
  });

  /* ── tools/list 返回 9 个内置工具（5 内部 + 3 外部 + ADR-0048 marketplace）─── */

  it('tools/list 返回 9 个内置工具', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { jsonrpc: '2.0', id: 400, method: 'tools/list' },
    });
    const body = JSON.parse(res.body);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, [
      'calendar',
      'decision.record',
      'email.send',
      'knowledge.query',
      'marketplace.act',
      'memory.add',
      'memory.search',
      'persona.get_context',
      'web_search',
    ]);
    /* 高风险工具应被标记 */
    const calendar = body.result.tools.find((t: { name: string; highRisk: boolean }) => t.name === 'calendar');
    assert.equal(calendar.highRisk, true);
    const email = body.result.tools.find((t: { name: string; highRisk: boolean }) => t.name === 'email.send');
    assert.equal(email.highRisk, true);
    const webSearch = body.result.tools.find((t: { name: string; highRisk: boolean }) => t.name === 'web_search');
    assert.equal(webSearch.highRisk, false);
    /* ADR-0048：marketplace 工具不静态标 highRisk（风险分级在 EarningPolicy +
     * ToolPermission，否则自主低风险 apply 会被 confirmation 永久卡死） */
    const marketplace = body.result.tools.find((t: { name: string; highRisk: boolean }) => t.name === 'marketplace.act');
    assert.equal(marketplace.highRisk, false);
  });

  it('调用历史可通过 admin REST 查询', async () => {
    const auth = new AgencyAuthorizationService(os.getDatabase());
    const perm = new ToolPermissionService(os.getDatabase());
    auth.create({
      tenantId, personaId, principalUserId: userId,
      scope: 'all', scopeDescription: 'Audit trail visibility test',
    });
    perm.grant({
      tenantId, personaId, toolId: 'persona.get_context',
      scope: 'read', constraints: {}, grantedBy: userId,
    });

    /* 调用一次 */
    await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        jsonrpc: '2.0', id: 13, method: 'tools/call',
        personaId,
        params: { name: 'persona.get_context', arguments: { ownerUserId: userId } },
      },
    });

    /* admin 查询历史（注册时自动赋 admin 角色，因此 accessToken 即 admin） */
    const histRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/personas/${personaId}/tool-invocations`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(histRes.statusCode, 200);
    const histBody = JSON.parse(histRes.body);
    assert.ok(Array.isArray(histBody.data));
    assert.ok(histBody.data.length >= 1);
    assert.equal(histBody.data[0].status, 'success');
    assert.equal(histBody.data[0].toolId, 'persona.get_context');
  });
});
