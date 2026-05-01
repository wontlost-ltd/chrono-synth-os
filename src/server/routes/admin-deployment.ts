import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { TenantEnterpriseProfileService, type TenantEnterpriseProfile } from '../../enterprise/tenant-enterprise-profile-service.js';
import { requireRole } from '../plugins/rbac.js';
import { UpdateDeploymentProfileSchema } from '../schemas/api-schemas.js';

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

function serializeProfile(profile: TenantEnterpriseProfile) {
  return {
    tenantId: profile.tenantId,
    deploymentMode: profile.deploymentMode,
    databaseIsolationMode: profile.databaseIsolationMode,
    kafkaNamespace: profile.kafkaNamespace,
    encryptionMode: profile.encryptionMode,
    kmsKeyRef: profile.kmsKeyRef,
    scimTokenConfigured: profile.scimTokenConfigured,
    oidc: profile.oidc,
    createdAt: toIso(profile.createdAt),
    updatedAt: toIso(profile.updatedAt),
  };
}

export function registerAdminDeploymentRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  const profileService = new TenantEnterpriseProfileService(db, config);

  app.get('/api/v1/admin/deployment/profile', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    return {
      data: serializeProfile(profileService.getProfile(request.tenantId)),
    };
  });

  app.put('/api/v1/admin/deployment/profile', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const patch = UpdateDeploymentProfileSchema.parse(request.body);
    const profile = profileService.upsertProfile(request.tenantId, patch);

    /* 切换到 dedicated_db 时自动创建租户专属 Kafka topic（幂等，异步，不阻塞响应） */
    if (profile.deploymentMode === 'dedicated_db') {
      profileService.provisionKafkaNamespace(request.tenantId).then((result) => {
        if (result.status === 'error') {
          app.log.error({ tenantId: request.tenantId, error: result.error }, 'Kafka namespace 创建失败');
        }
      }).catch((err: unknown) => {
        app.log.error({ err, tenantId: request.tenantId }, 'Kafka namespace 创建异常');
      });
    }

    return {
      data: serializeProfile(profile),
    };
  });

  app.post('/api/v1/admin/deployment/scim-token', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    const token = `scim_${randomBytes(24).toString('hex')}`;
    profileService.storeScimToken(request.tenantId, token);
    return {
      data: {
        token,
        tenantId: request.tenantId,
        issuedAt: new Date().toISOString(),
      },
    };
  });
}

