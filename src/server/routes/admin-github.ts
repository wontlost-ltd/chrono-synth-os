/**
 * GitHub App 安装入口（安装入口产品化）——管理端凭据录入 + setup_url 回调。
 *
 * 此前把 App 装进系统只能靠一次性脚本 scripts/connect-github.ts（需 SSH 登服务器、
 * 设 5 个环境变量）。本路由把它产品化为两步：
 *   ① 管理员 POST 一次凭据（appId + 私钥 PEM + webhook secret）；
 *   ② 在 GitHub 上安装 App → setup_url 回调自动记 installation → 租户映射。
 *
 * **私钥安全三条**：
 *   - 只经 POST body 进入（绝不 GET/URL——URL 会进日志、浏览器历史、Referer）；
 *   - 经 GithubAppCredentialStore.storeApp 由 FieldEncryption 加密落库
 *     （store 自身 fail-closed：加密未启用直接拒写，不依赖调用方纪律）；
 *   - **响应体绝不回显私钥**——GET 只返 configured/appId/gheBaseUrl/installations。
 *
 * **首要安全不变量（setup 回调）**：回调是 GitHub 发起的浏览器跳转，**无 HMAC 可验**
 * （不同于 webhook）。故它必须走正常 JWT 鉴权（**不得**加入 isPublicPath 豁免），
 * 且租户取自 request.tenantId（会话），**绝不从 URL 参数推断**——否则任何人构造
 * ?installation_id=<他人的> 就能把别人的 installation 绑到自己租户下，进而用自己的
 * 会话读取他人组织的 GitHub 内容。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import { ValidationError, StateError, ErrorCode } from '../../errors/index.js';
import { requireRole } from '../plugins/rbac.js';
import { tryByokEncryption } from '../../storage/llm-credential-store.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import { ConnectAppSchema } from '../schemas/api-schemas.js';
import { githubAppCredDelete, githubInstallListByTenant } from '@chrono/kernel';

/** 公有云 GitHub host（首版只处理 github.com，与 webhook 一致）。 */
const GITHUB_HOST = 'github.com';


export interface AdminGithubRoutesDeps {
  os: ChronoSynthOS;
  tenantFactory: TenantOSFactory | undefined;
  config: AppConfig;
}

export function registerAdminGithubRoutes(app: FastifyInstance, deps: AdminGithubRoutesDeps): void {
  const { os, tenantFactory, config } = deps;
  const encryption = tryByokEncryption(config.encryption);

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /** 造本租户的凭据 store；加密未启用 → 明确 4xx（storeApp 本身也 fail-closed，这里给可读错误）。 */
  function storeFor(request: FastifyRequest): GithubAppCredentialStore {
    if (!encryption) {
      throw new StateError('未启用凭据加密，无法安全保存 GitHub App 私钥——请先启用 CHRONO_ENCRYPTION_ENABLED');
    }
    return new GithubAppCredentialStore(getOS(request).getDatabase(), encryption, request.tenantId);
  }

  /* POST /api/v1/admin/github/app —— 录入 App 凭据（私钥只经 body，加密落库，绝不回显）。 */
  app.post('/api/v1/admin/github/app', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const body = ConnectAppSchema.parse(request.body);
    const user = request.user as JwtPayload | undefined;
    const tenantOS = getOS(request);

    storeFor(request).storeApp(
      body.appId, body.privateKeyPem, body.webhookSecret,
      body.gheBaseUrl ?? null, user?.sub ?? 'admin', tenantOS.getClock().now(),
    );

    /* 响应只回 appId——私钥绝不回显。 */
    return { data: { appId: body.appId, configured: true } };
  });

  /* GET /api/v1/admin/github/app —— 查连接状态（**不含私钥**）。 */
  app.get('/api/v1/admin/github/app', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const cred = encryption ? storeFor(request).getApp() : undefined;
    if (!cred) {
      return { data: { configured: false, installations: [] } };
    }
    const rows = getOS(request).getDatabase().queryMany(githubInstallListByTenant(request.tenantId));
    return {
      data: {
        configured: true,
        appId: cred.appId,
        gheBaseUrl: cred.gheBaseUrl,
        installations: rows.map((r) => ({
          installationId: r.installation_id,
          account: r.account,
          repos: r.repos,
          suspendedAt: r.suspended_at,
        })),
      },
    };
  });

  /* DELETE /api/v1/admin/github/app —— 断开连接（删凭据；installation 映射由卸载事件清理）。 */
  app.delete('/api/v1/admin/github/app', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    getOS(request).getDatabase().execute(githubAppCredDelete(request.tenantId));
    return { data: { disconnected: true } };
  });

  /* GET /api/v1/integrations/github/setup —— GitHub 安装完成回调。
   *
   * **必须已登录**：本端点不在 isPublicPath 豁免名单内，走正常 JWT 鉴权。
   * 租户取自会话（request.tenantId），绝不从 URL 参数推断——见文件头安全说明。 */
  app.get('/api/v1/integrations/github/setup', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const installationId = typeof query.installation_id === 'string' ? query.installation_id.trim() : '';
    if (installationId.length === 0) {
      throw new ValidationError('回调缺少 installation_id 参数', ErrorCode.VALIDATION_REQUIRED);
    }

    const tenantOS = getOS(request);
    /* 租户 = 会话租户。account/repos 此时未知（GitHub 回调不带），留 null 由
     * installation_repositories 事件后续同步。 */
    storeFor(request).upsertInstallation(
      installationId, GITHUB_HOST, null, null, tenantOS.getClock().now(),
    );

    /* 极简静态确认页（无用户输入回显 → 无 XSS 面）。 */
    reply.header('content-type', 'text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>GitHub 已连接</title>
<body style="font-family:system-ui;padding:2rem;max-width:32rem">
<h1>GitHub 已连接</h1>
<p>安装已绑定到你的账号，数字人可以开始学习这个组织的知识了。</p>
<p>你可以关闭此页面。</p>
</body>`;
  });
}
