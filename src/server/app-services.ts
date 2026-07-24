/**
 * AppServices — 集中构建所有应用层服务实例
 *
 * 路由层只依赖此容器，不再直接依赖 IDatabase 或 AppConfig。
 * 这是 NRT-01 过渡的核心：控制面 services 在启动时统一初始化，
 * 路由层通过依赖注入接收已就绪的 service 实例。
 */

import type { IDatabase } from '../storage/database.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { IdentityService } from '../identity/identity-service.js';
import { CollaborationService } from '../identity/collaboration-service.js';
import { MobileDeviceFacade } from '../identity/mobile-device-facade.js';
import { UserProfileService } from '../identity/user-profile-service.js';
import { UserEmailDirectoryService } from '../identity/user-email-directory-service.js';
import { OrganizationService } from '../enterprise/organization-service.js';
import { ScimTenantDirectory } from '../enterprise/scim-tenant-directory.js';
import { ScimProvisioningService } from '../enterprise/scim-provisioning-service.js';
import { recordEvidence } from '../compliance/evidence-store.js';
import { AdminControlPlaneService } from '../enterprise/admin-control-plane-service.js';
import { ApiKeyService } from '../billing/api-key-service.js';
import { KnowledgeSourceService } from '../knowledge/knowledge-source-service.js';
import { MockPushService } from './services/push-service.js';
import type { PushService } from '../types/push.js';

/**
 * 分片 Phase 0 · Plan 1b（Task 9）：删裸 host db 逃生口 + 未用 carrier。
 * - 删 `db: IDatabase` 字段——tenant-scoped service 已全 resolver 化，此字段是错-shard 逃生口
 *   （唯一消费者 organizations.ts RBAC preHandler 已改经 resolver.dbForTenant(request.tenantId)）。
 * - 删 `auth`/`avatar`/`mobileDevice`/`tenantProfile`/`config` 死 carrier——这些成员无任何 route/组合根
 *   从 services 消费（各 route 就地各自构造：auth.ts new AuthService、avatars.ts new AvatarService、
 *   nudge-push-bridge/build-dispatcher/facade new MobileDeviceService、auth-oidc/persona-core/admin-deployment
 *   new TenantEnterpriseProfileService、admin-config.ts new ConfigService）。留在容器里只是白挂 DB-capability 载体。
 */
export interface AppServices {
  readonly identity: IdentityService;
  readonly collaboration: CollaborationService;
  readonly mobileDeviceFacade: MobileDeviceFacade;
  /** 推送服务（ADR-0054 ③ nudge push 桥复用同一实例；生产可换 FCM/APNs provider）。 */
  readonly pushService: PushService;
  readonly userProfile: UserProfileService;
  /** 用户 email 目录（全局 email 唯一性 → updateEmail，mixed-scope，Plan 1b 单库过渡 coordinatorDb，Plan 1c 替换实现）。 */
  readonly userEmailDirectory: UserEmailDirectoryService;
  readonly organization: OrganizationService;
  /** SCIM 租户目录（token→tenant 反查，mixed-scope，Plan 1b 单库过渡 coordinatorDb，Plan 1c 替换实现）。 */
  readonly scimDirectory: ScimTenantDirectory;
  readonly scim: ScimProvisioningService;
  readonly adminControlPlane: AdminControlPlaneService;
  readonly apiKey: ApiKeyService;
  readonly knowledgeSource: KnowledgeSourceService;
}

export function buildAppServices(
  /**
   * host db：仍供 mixed-scope 过渡成员用——mobileDeviceFacade（Plan 3 queue/worker shard 决策前）、
   * scim 的 SOC2 证据记录（recordEvidence，coordinator/platform 级，归 Plan 1c 明确来源）。
   * tenant-scoped 成员一律经 resolver，不碰此 db。
   */
  db: IDatabase,
  /** 保留参数（签名稳定性）：Task 9 删掉 config/tenantProfile 死 carrier 后，本函数不再直接消费 appConfig。 */
  appConfig: AppConfig,
  /**
   * 分片 Phase 0 · Plan 1b：组合根穿进的唯一共享 `TenantDbResolver`。
   * 全 tenant-scoped 成员据此按 tenantId 解析 shard（Task 1-8 已全接线）。
   */
  resolver: TenantDbResolver,
  logger?: Logger,
): AppServices {
  void appConfig;
  const pushService = new MockPushService(logger);
  const tx = db;

  return {
    identity: new IdentityService(resolver),
    /* 分片 Plan 1b（Task 4 Collaboration 组）：CollaborationService 经共享 resolver 按 tenantId 路由
     * （shared_simulations 无 tenant_id，租户约束经 life_simulations 父归属）。 */
    collaboration: new CollaborationService(resolver),
    mobileDeviceFacade: new MobileDeviceFacade(tx, resolver, pushService),
    pushService,
    /* 分片 Plan 1b（Task 7）：UserProfileService 经共享 resolver 按 tenantId 路由（users 表有 tenant_id）；
     * getProfile/changePassword 均带 tenantId + WHERE tenant_id=? AND id=? 双重约束。 */
    userProfile: new UserProfileService(resolver),
    /* 分片 Plan 1b（Task 7）：UserEmailDirectoryService 承载 updateEmail（全局 email 唯一性，mixed-scope）。
     * 单库过渡经 coordinatorDb（=host db，行为不变）；真跨 shard 目录写一致性 = Plan 1c 替换实现（route 契约不变）。 */
    userEmailDirectory: new UserEmailDirectoryService(resolver),
    /* 分片 Plan 1b（Task 5）：OrganizationService 经共享 resolver 按 tenantId 路由（org 系列表全有 tenant_id）。 */
    organization: new OrganizationService(resolver),
    /* 分片 Plan 1b（Task 6）：ScimTenantDirectory 承载 token→tenant 反查（mixed-scope）。
     * 单库过渡经 coordinatorDb（=host db，行为不变）；真跨 shard 目录一致性 = Plan 1c 替换实现（route 契约不变）。 */
    scimDirectory: new ScimTenantDirectory(resolver),
    /* 分片 Plan 1c（Task 6）：ScimProvisioningService 经协调库目录定位 email→tenant，写走 resolver 路由 shard。
     * 证据记录 recordEvidence(db, ...) 是 coordinator/platform 级（SOC2 CC6.1），保留 host db。 */
    scim: new ScimProvisioningService(
      resolver,
      ({ tenantId, evidenceType, payload }) => {
        /* SCIM 操作发出 SOC2 CC6.1 证据：覆盖 provisioning + deprovisioning。 */
        recordEvidence(db, {
          tenantId,
          controlId: 'CC6.1',
          evidenceType,
          payload,
          metadata: { collector_id: 'scim-provisioning-service' },
        });
      },
      ({ tenantId, evidenceType, error }) => {
        /* 证据写入失败 → 结构化日志，便于 SRE 监控 CC6.1 漏报。 */
        logger?.error('ScimProvisioning', 'CC6.1 evidence write failed', {
          tenantId, evidenceType, error: error.message,
        });
      },
    ),
    /* 分片 Plan 1b（Task 5）：AdminControlPlaneService 经共享 resolver 按 tenantId 路由（persona/task/wallet/gov 表全有 tenant_id）。 */
    adminControlPlane: new AdminControlPlaneService(resolver),
    /* 分片 Plan 1b（Task 8）：ApiKeyService 管理方法（create/list/revoke，已带 tenantId）经共享 resolver 按 tenantId 路由
     * （api_keys 表有 tenant_id 列，query 层已含 tenant predicate）。key hash→tenant 反查在 auth 中间件（server/plugins/auth.ts），归 Plan 1c。 */
    apiKey: new ApiKeyService(resolver),
    /* 分片 Plan 1b（Task 5）：KnowledgeSourceService 经共享 resolver 按 tenantId 路由（knowledge_sources 表有 tenant_id）。 */
    knowledgeSource: new KnowledgeSourceService(resolver),
  };
}
