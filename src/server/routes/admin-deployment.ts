import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import type { AppConfig } from '../../config/schema.js';
import type { TenantEnterpriseProfile } from '../../enterprise/tenant-enterprise-profile-service.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';
import { ScimTenantDirectory } from '../../enterprise/scim-tenant-directory.js';
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

interface TenantKeyVersionRow {
  key_ref: string;
  provider: string;
  version: number;
  status: string;
  created_at: number;
  revoked_at: number | null;
}

interface LatestTenantKeyVersionRow {
  provider: string;
  version: number;
}

interface TenantVaultAuditRow {
  id: string;
  operation: string;
  key_ref: string;
  key_version: number | null;
  outcome: string;
  error_message: string | null;
  performed_at: number;
}

export function registerAdminDeploymentRoutes(app: FastifyInstance, _db: IDatabase, resolver: TenantDbResolver, config: AppConfig): void {
  /* 分片 Plan 1b：profile 读写经 resolver（tenant-scoped）；SCIM token 存经 ScimTenantDirectory（mixed-scope）。
   * 分片 Plan 2 · Task 6：vault keys/audit 直查（tenant_key_versions / tenant_vault_audit）亦全下沉
   * resolver.dbForTenant——本 registrar 内不再有裸 db 直查（db 入参保留仅为装配调用点兼容）。 */
  const profileService = new TenantEnterpriseProfileService(resolver, config);
  const scimDirectory = new ScimTenantDirectory(resolver);

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

  /* GET /api/v1/admin/deployment/manifest — tenant data manifest (data plane contract) */
  app.get('/api/v1/admin/deployment/manifest', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    return {
      data: profileService.getManifest(request.tenantId),
    };
  });

  app.post('/api/v1/admin/deployment/scim-token', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    const token = `scim_${randomBytes(24).toString('hex')}`;
    scimDirectory.storeScimToken(request.tenantId, token);
    return {
      data: {
        token,
        tenantId: request.tenantId,
        issuedAt: new Date().toISOString(),
      },
    };
  });

  app.get('/api/v1/admin/vault/keys', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    /* 分片 Plan 2 · Task 6：tenant_key_versions 直查下沉 resolver.dbForTenant(tenantId)
     * （tenant-scoped，SQL 仍带 WHERE tenant_id；多 shard 下路由到租户所在 shard，单库等价现状）。 */
    const rows = resolver.dbForTenant(request.tenantId)
      .prepare<TenantKeyVersionRow>(
        `SELECT key_ref, provider, version, status, created_at, revoked_at
         FROM tenant_key_versions
         WHERE tenant_id = ?
         ORDER BY key_ref, version DESC`,
      )
      .all(request.tenantId);

    return {
      data: rows.map((row) => ({
        keyRef: row.key_ref,
        provider: row.provider,
        version: row.version,
        status: row.status,
        createdAt: toIso(row.created_at),
        revokedAt: toIso(row.revoked_at),
      })),
    };
  });

  app.post<{ Params: { keyRef: string } }>('/api/v1/admin/vault/keys/:keyRef/rotate', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    /* 分片 Plan 2 · Task 6：读既有版本 + 事务内写新版本全下沉 resolver.dbForTenant（同一 shard db 内开事务，
     * 源库=写库同 shard，防跨 shard 串写）。 */
    const tenantDb = resolver.dbForTenant(request.tenantId);
    const created = tenantDb.transaction(() => {
      const latest = tenantDb
        .prepare<LatestTenantKeyVersionRow>(
          `SELECT provider, version
           FROM tenant_key_versions
           WHERE tenant_id = ? AND key_ref = ?
           ORDER BY version DESC
           LIMIT 1`,
        )
        .get(request.tenantId, request.params.keyRef);
      const provider = latest?.provider ?? 'platform';
      const version = (latest?.version ?? 0) + 1;
      const createdAt = Date.now();

      tenantDb
        .prepare(
          `INSERT INTO tenant_key_versions(id, tenant_id, key_ref, provider, version, status, created_at)
           VALUES(?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(randomUUID(), request.tenantId, request.params.keyRef, provider, version, createdAt);

      return {
        keyRef: request.params.keyRef,
        version,
        status: 'active',
        createdAt: toIso(createdAt),
      };
    });

    return { data: created };
  });

  app.post<{ Params: { keyRef: string } }>('/api/v1/admin/vault/keys/:keyRef/revoke', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    /* 分片 Plan 2 · Task 6：tenant_key_versions 撤销直查下沉 resolver.dbForTenant(tenantId)。 */
    const result = resolver.dbForTenant(request.tenantId)
      .prepare(
        `UPDATE tenant_key_versions
         SET status = 'revoked', revoked_at = ?
         WHERE tenant_id = ? AND key_ref = ? AND status = 'active'`,
      )
      .run(Date.now(), request.tenantId, request.params.keyRef);

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'No active key version found' });
    }

    return {
      data: {
        keyRef: request.params.keyRef,
        revokedCount: result.changes,
      },
    };
  });

  app.get('/api/v1/admin/vault/audit', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    /* 分片 Plan 2 · Task 6：tenant_vault_audit 直查下沉 resolver.dbForTenant(tenantId)。 */
    const rows = resolver.dbForTenant(request.tenantId)
      .prepare<TenantVaultAuditRow>(
        `SELECT id, operation, key_ref, key_version, outcome, error_message, performed_at
         FROM tenant_vault_audit
         WHERE tenant_id = ?
         ORDER BY performed_at DESC
         LIMIT 50`,
      )
      .all(request.tenantId);

    return {
      data: rows.map((row) => ({
        id: row.id,
        operation: row.operation,
        keyRef: row.key_ref,
        keyVersion: row.key_version,
        outcome: row.outcome,
        errorMessage: row.error_message,
        performedAt: toIso(row.performed_at),
      })),
    };
  });
}
