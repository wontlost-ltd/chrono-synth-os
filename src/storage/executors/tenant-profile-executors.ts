/**
 * 租户企业配置 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  TPROF_QUERY_BY_TENANT, TPROF_QUERY_BY_SCIM_TOKEN,
  TPROF_CMD_UPDATE, TPROF_CMD_INSERT,
  TPROF_CMD_UPDATE_SCIM_TOKEN, TPROF_CMD_INSERT_WITH_SCIM_TOKEN,
  TPROF_CMD_UPDATE_BYOS,
} from '@chrono/kernel';
import type {
  TprofRow, TprofScimTenantRow,
  TprofUpdateParams, TprofInsertParams,
  TprofUpdateScimTokenParams, TprofInsertWithScimTokenParams,
  TprofUpdateByosParams,
} from '@chrono/kernel';

export function registerTenantProfileExecutors(): void {
  registerQuery<TprofRow | null, string>(TPROF_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<TprofRow>(
      'SELECT * FROM tenant_enterprise_profiles WHERE tenant_id = ? LIMIT 1',
    ).get(tenantId) ?? null;
  });

  registerQuery<TprofScimTenantRow | null, string>(TPROF_QUERY_BY_SCIM_TOKEN, (db, tokenHash) => {
    return db.prepare<TprofScimTenantRow>(
      'SELECT tenant_id FROM tenant_enterprise_profiles WHERE scim_token_hash = ? LIMIT 1',
    ).get(tokenHash) ?? null;
  });

  registerCommand<TprofUpdateParams>(TPROF_CMD_UPDATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tenant_enterprise_profiles
       SET deployment_mode = ?,
           database_isolation_mode = ?,
           kafka_namespace = ?,
           encryption_mode = ?,
           kms_key_ref = ?,
           oidc_enabled = ?,
           oidc_issuer_url = ?,
           oidc_client_id = ?,
           oidc_client_secret_encrypted = ?,
           oidc_audience = ?,
           oidc_scope = ?,
           oidc_email_claim = ?,
           oidc_name_claim = ?,
           updated_at = ?
       WHERE tenant_id = ?`,
    ).run(
      p.deploymentMode, p.databaseIsolationMode, p.kafkaNamespace,
      p.encryptionMode, p.kmsKeyRef,
      p.oidcEnabled, p.oidcIssuerUrl, p.oidcClientId, p.oidcClientSecretEncrypted,
      p.oidcAudience, p.oidcScope, p.oidcEmailClaim, p.oidcNameClaim,
      p.now, p.tenantId,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<TprofInsertParams>(TPROF_CMD_INSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_enterprise_profiles (
        tenant_id, deployment_mode, database_isolation_mode, kafka_namespace,
        encryption_mode, kms_key_ref, scim_token_hash,
        oidc_enabled, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted,
        oidc_audience, oidc_scope, oidc_email_claim, oidc_name_claim,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.tenantId, p.deploymentMode, p.databaseIsolationMode, p.kafkaNamespace,
      p.encryptionMode, p.kmsKeyRef,
      p.oidcEnabled, p.oidcIssuerUrl, p.oidcClientId, p.oidcClientSecretEncrypted,
      p.oidcAudience, p.oidcScope, p.oidcEmailClaim, p.oidcNameClaim,
      p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<TprofUpdateScimTokenParams>(TPROF_CMD_UPDATE_SCIM_TOKEN, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE tenant_enterprise_profiles SET scim_token_hash = ?, updated_at = ? WHERE tenant_id = ?',
    ).run(p.tokenHash, p.now, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<TprofInsertWithScimTokenParams>(TPROF_CMD_INSERT_WITH_SCIM_TOKEN, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_enterprise_profiles (
        tenant_id, deployment_mode, database_isolation_mode, kafka_namespace,
        encryption_mode, kms_key_ref, scim_token_hash,
        oidc_enabled, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted,
        oidc_audience, oidc_scope, oidc_email_claim, oidc_name_claim,
        created_at, updated_at
      ) VALUES (?, 'shared_cluster', 'shared', '', 'platform_managed', NULL, ?, 0, '', '', '', '', 'openid profile email', 'email', 'name', ?, ?)`,
    ).run(p.tenantId, p.tokenHash, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<TprofUpdateByosParams>(TPROF_CMD_UPDATE_BYOS, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tenant_enterprise_profiles
          SET byos_provider = ?, byos_bucket = ?, byos_key_prefix = ?
        WHERE tenant_id = ?`,
    ).run(p.byosProvider, p.byosBucket, p.byosKeyPrefix, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
