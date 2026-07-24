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
import { AuthService } from '../identity/auth-service.js';
import { IdentityService } from '../identity/identity-service.js';
import { AvatarService } from '../identity/avatar-service.js';
import { CollaborationService } from '../identity/collaboration-service.js';
import { MobileDeviceFacade } from '../identity/mobile-device-facade.js';
import { MobileDeviceService } from '../identity/mobile-device-service.js';
import { UserProfileService } from '../identity/user-profile-service.js';
import { UserEmailDirectoryService } from '../identity/user-email-directory-service.js';
import { OrganizationService } from '../enterprise/organization-service.js';
import { TenantEnterpriseProfileService } from '../enterprise/tenant-enterprise-profile-service.js';
import { ScimTenantDirectory } from '../enterprise/scim-tenant-directory.js';
import { ScimProvisioningService } from '../enterprise/scim-provisioning-service.js';
import { recordEvidence } from '../compliance/evidence-store.js';
import { AdminControlPlaneService } from '../enterprise/admin-control-plane-service.js';
import { ApiKeyService } from '../billing/api-key-service.js';
import { ConfigService } from '../config/config-service.js';
import { KnowledgeSourceService } from '../knowledge/knowledge-source-service.js';
import { MockPushService } from './services/push-service.js';
import type { PushService } from '../types/push.js';

export interface AppServices {
  readonly db: IDatabase;
  readonly auth: AuthService;
  readonly identity: IdentityService;
  readonly avatar: AvatarService;
  readonly collaboration: CollaborationService;
  readonly mobileDevice: MobileDeviceService;
  readonly mobileDeviceFacade: MobileDeviceFacade;
  /** 推送服务（ADR-0054 ③ nudge push 桥复用同一实例；生产可换 FCM/APNs provider）。 */
  readonly pushService: PushService;
  readonly userProfile: UserProfileService;
  /** 用户 email 目录（全局 email 唯一性 → updateEmail，mixed-scope，Plan 1b 单库过渡 coordinatorDb，Plan 1c 替换实现）。 */
  readonly userEmailDirectory: UserEmailDirectoryService;
  readonly organization: OrganizationService;
  readonly tenantProfile: TenantEnterpriseProfileService;
  /** SCIM 租户目录（token→tenant 反查，mixed-scope，Plan 1b 单库过渡 coordinatorDb，Plan 1c 替换实现）。 */
  readonly scimDirectory: ScimTenantDirectory;
  readonly scim: ScimProvisioningService;
  readonly adminControlPlane: AdminControlPlaneService;
  readonly apiKey: ApiKeyService;
  readonly config: ConfigService;
  readonly knowledgeSource: KnowledgeSourceService;
}

export function buildAppServices(
  db: IDatabase,
  appConfig: AppConfig,
  /**
   * 分片 Phase 0 · Plan 1b：组合根穿进的唯一共享 `TenantDbResolver`。
   * tenant-scoped 服务据此按 tenantId 解析 shard（本 Task 只 IdentityService 接线，其余成员逐 Task 迁移）。
   */
  resolver: TenantDbResolver,
  logger?: Logger,
): AppServices {
  const pushService = new MockPushService(logger);
  const tx = db;

  return {
    db,
    auth: new AuthService(tx, appConfig),
    identity: new IdentityService(resolver),
    /* 分片 Plan 1b（Task 2 Avatar 组）：AvatarService 经共享 resolver 按 tenantId 路由。 */
    avatar: new AvatarService(resolver),
    /* 分片 Plan 1b（Task 4 Collaboration 组）：CollaborationService 经共享 resolver 按 tenantId 路由
     * （shared_simulations 无 tenant_id，租户约束经 life_simulations 父归属）。 */
    collaboration: new CollaborationService(resolver),
    /* 分片 Plan 1b（Task 3 Mobile 组）：MobileDeviceService 经共享 resolver 按 tenantId 路由（device 表有 tenant_id）。 */
    mobileDevice: new MobileDeviceService(resolver),
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
    /* 分片 Plan 1b（Task 6）：TenantEnterpriseProfileService 经共享 resolver 按 tenantId 路由
     * （tenant_enterprise_profiles 主键即 tenant_id；profile/OIDC/KMS 方法均已带 tenantId）。 */
    tenantProfile: new TenantEnterpriseProfileService(resolver, appConfig, logger),
    /* 分片 Plan 1b（Task 6）：ScimTenantDirectory 承载 token→tenant 反查（mixed-scope）。
     * 单库过渡经 coordinatorDb（=host db，行为不变）；真跨 shard 目录一致性 = Plan 1c 替换实现（route 契约不变）。 */
    scimDirectory: new ScimTenantDirectory(resolver),
    scim: new ScimProvisioningService(
      tx,
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
    apiKey: new ApiKeyService(tx),
    config: new ConfigService(db, appConfig),
    /* 分片 Plan 1b（Task 5）：KnowledgeSourceService 经共享 resolver 按 tenantId 路由（knowledge_sources 表有 tenant_id）。 */
    knowledgeSource: new KnowledgeSourceService(resolver),
  };
}
