/**
 * AppServices — 集中构建所有应用层服务实例
 *
 * 路由层只依赖此容器，不再直接依赖 IDatabase 或 AppConfig。
 * 这是 NRT-01 过渡的核心：控制面 services 在启动时统一初始化，
 * 路由层通过依赖注入接收已就绪的 service 实例。
 */

import type { IDatabase } from '../storage/database.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { AuthService } from '../identity/auth-service.js';
import { IdentityService } from '../identity/identity-service.js';
import { AvatarService } from '../identity/avatar-service.js';
import { CollaborationService } from '../identity/collaboration-service.js';
import { MobileDeviceFacade } from '../identity/mobile-device-facade.js';
import { MobileDeviceService } from '../identity/mobile-device-service.js';
import { UserProfileService } from '../identity/user-profile-service.js';
import { OrganizationService } from '../enterprise/organization-service.js';
import { TenantEnterpriseProfileService } from '../enterprise/tenant-enterprise-profile-service.js';
import { ScimProvisioningService } from '../enterprise/scim-provisioning-service.js';
import { recordEvidence } from '../compliance/evidence-store.js';
import { AdminControlPlaneService } from '../enterprise/admin-control-plane-service.js';
import { ApiKeyService } from '../billing/api-key-service.js';
import { ConfigService } from '../config/config-service.js';
import { KnowledgeSourceService } from '../knowledge/knowledge-source-service.js';
import { MockPushService } from './services/push-service.js';

export interface AppServices {
  readonly db: IDatabase;
  readonly auth: AuthService;
  readonly identity: IdentityService;
  readonly avatar: AvatarService;
  readonly collaboration: CollaborationService;
  readonly mobileDevice: MobileDeviceService;
  readonly mobileDeviceFacade: MobileDeviceFacade;
  readonly userProfile: UserProfileService;
  readonly organization: OrganizationService;
  readonly tenantProfile: TenantEnterpriseProfileService;
  readonly scim: ScimProvisioningService;
  readonly adminControlPlane: AdminControlPlaneService;
  readonly apiKey: ApiKeyService;
  readonly config: ConfigService;
  readonly knowledgeSource: KnowledgeSourceService;
}

export function buildAppServices(
  db: IDatabase,
  appConfig: AppConfig,
  logger?: Logger,
): AppServices {
  const pushService = new MockPushService(logger);
  const tx = db;

  return {
    db,
    auth: new AuthService(tx, appConfig),
    identity: new IdentityService(tx),
    avatar: new AvatarService(tx),
    collaboration: new CollaborationService(tx),
    mobileDevice: new MobileDeviceService(tx),
    mobileDeviceFacade: new MobileDeviceFacade(tx, pushService),
    userProfile: new UserProfileService(tx),
    organization: new OrganizationService(tx),
    tenantProfile: new TenantEnterpriseProfileService(tx, appConfig, logger),
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
    adminControlPlane: new AdminControlPlaneService(tx),
    apiKey: new ApiKeyService(tx),
    config: new ConfigService(db, appConfig),
    knowledgeSource: new KnowledgeSourceService(tx),
  };
}
