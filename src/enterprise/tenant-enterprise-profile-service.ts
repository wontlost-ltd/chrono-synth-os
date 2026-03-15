import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import type { IDatabase } from '../storage/database.js';
import { FieldEncryption } from '../storage/encryption.js';
import {
  assertValidKafkaNamespace,
  defaultKafkaNamespaceForTenant,
  normalizeKafkaNamespace,
} from './tenant-kafka-topics.js';

type DeploymentMode = 'shared_cluster' | 'dedicated_db';
type DatabaseIsolationMode = 'shared' | 'dedicated';
type EncryptionMode = 'platform_managed' | 'tenant_dedicated';

interface TenantEnterpriseProfileRow {
  tenant_id: string;
  deployment_mode: DeploymentMode;
  database_isolation_mode: DatabaseIsolationMode;
  kafka_namespace: string;
  encryption_mode: EncryptionMode;
  kms_key_ref: string | null;
  scim_token_hash: string | null;
  oidc_enabled: number;
  oidc_issuer_url: string;
  oidc_client_id: string;
  oidc_client_secret_encrypted: string;
  oidc_audience: string;
  oidc_scope: string;
  oidc_email_claim: string;
  oidc_name_claim: string;
  created_at: number;
  updated_at: number;
}

export interface EffectiveOidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  scope: string;
  emailClaim: string;
  nameClaim: string;
}

export interface TenantEnterpriseProfile {
  tenantId: string;
  deploymentMode: DeploymentMode;
  databaseIsolationMode: DatabaseIsolationMode;
  kafkaNamespace: string | null;
  encryptionMode: EncryptionMode;
  kmsKeyRef: string | null;
  scimTokenConfigured: boolean;
  oidc: {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecretConfigured: boolean;
    audience: string;
    scope: string;
    emailClaim: string;
    nameClaim: string;
  };
  createdAt: number | null;
  updatedAt: number | null;
}

export interface TenantEnterpriseProfilePatch {
  deploymentMode?: DeploymentMode;
  databaseIsolationMode?: DatabaseIsolationMode;
  kafkaNamespace?: string | null;
  encryptionMode?: EncryptionMode;
  kmsKeyRef?: string | null;
  oidc?: {
    enabled?: boolean;
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    audience?: string;
    scope?: string;
    emailClaim?: string;
    nameClaim?: string;
  };
}

const DEFAULT_PROFILE: Omit<TenantEnterpriseProfile, 'tenantId' | 'createdAt' | 'updatedAt'> = {
  deploymentMode: 'shared_cluster',
  databaseIsolationMode: 'shared',
  kafkaNamespace: null,
  encryptionMode: 'platform_managed',
  kmsKeyRef: null,
  scimTokenConfigured: false,
  oidc: {
    enabled: false,
    issuerUrl: '',
    clientId: '',
    clientSecretConfigured: false,
    audience: '',
    scope: 'openid profile email',
    emailClaim: 'email',
    nameClaim: 'name',
  },
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toProfile(row: TenantEnterpriseProfileRow | undefined): TenantEnterpriseProfile {
  if (!row) {
    return {
      tenantId: 'default',
      ...DEFAULT_PROFILE,
      createdAt: null,
      updatedAt: null,
    };
  }

  return {
    tenantId: row.tenant_id,
    deploymentMode: row.deployment_mode,
    databaseIsolationMode: row.database_isolation_mode,
    kafkaNamespace: normalizeOptionalString(row.kafka_namespace),
    encryptionMode: row.encryption_mode,
    kmsKeyRef: normalizeOptionalString(row.kms_key_ref),
    scimTokenConfigured: Boolean(row.scim_token_hash),
    oidc: {
      enabled: Boolean(row.oidc_enabled),
      issuerUrl: row.oidc_issuer_url,
      clientId: row.oidc_client_id,
      clientSecretConfigured: row.oidc_client_secret_encrypted.length > 0,
      audience: row.oidc_audience,
      scope: row.oidc_scope,
      emailClaim: row.oidc_email_claim,
      nameClaim: row.oidc_name_claim,
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class TenantEnterpriseProfileService {
  constructor(
    private readonly db: IDatabase,
    private readonly config: AppConfig,
  ) {}

  getProfile(tenantId: string): TenantEnterpriseProfile {
    const row = this.getRow(tenantId);
    const profile = toProfile(row);
    return row ? profile : { ...profile, tenantId };
  }

  upsertProfile(tenantId: string, patch: TenantEnterpriseProfilePatch): TenantEnterpriseProfile {
    const existing = this.getRow(tenantId);
    const current = this.getProfile(tenantId);
    const now = Date.now();

    const deploymentMode = patch.deploymentMode ?? current.deploymentMode;
    const databaseIsolationMode = patch.databaseIsolationMode
      ?? current.databaseIsolationMode
      ?? (deploymentMode === 'dedicated_db' ? 'dedicated' : 'shared');
    const kafkaNamespace = patch.kafkaNamespace !== undefined
      ? normalizeKafkaNamespace(patch.kafkaNamespace)
      : normalizeKafkaNamespace(current.kafkaNamespace)
        ?? (deploymentMode === 'dedicated_db' ? defaultKafkaNamespaceForTenant(tenantId) : null);
    const encryptionMode = patch.encryptionMode ?? current.encryptionMode;
    const kmsKeyRef = patch.kmsKeyRef !== undefined
      ? normalizeOptionalString(patch.kmsKeyRef)
      : current.kmsKeyRef;
    const oidcPatch = patch.oidc ?? {};
    const currentOidcSecret = existing
      ? this.decryptSecret(existing.oidc_client_secret_encrypted)
      : '';
    const oidcSecret = oidcPatch.clientSecret !== undefined
      ? oidcPatch.clientSecret
      : currentOidcSecret;

    if (encryptionMode === 'tenant_dedicated' && !kmsKeyRef) {
      throw new ValidationError('tenant_dedicated 模式必须提供 kmsKeyRef', ErrorCode.VALIDATION_REQUIRED);
    }
    this.assertKnownKeyRef(kmsKeyRef);
    assertValidKafkaNamespace(kafkaNamespace);

    const oidcEnabled = oidcPatch.enabled ?? current.oidc.enabled;
    const oidcIssuerUrl = oidcPatch.issuerUrl ?? current.oidc.issuerUrl;
    const oidcClientId = oidcPatch.clientId ?? current.oidc.clientId;
    const oidcAudience = oidcPatch.audience ?? current.oidc.audience;
    const oidcScope = oidcPatch.scope ?? current.oidc.scope;
    const oidcEmailClaim = oidcPatch.emailClaim ?? current.oidc.emailClaim;
    const oidcNameClaim = oidcPatch.nameClaim ?? current.oidc.nameClaim;

    if (oidcEnabled && (!oidcIssuerUrl || !oidcClientId || !oidcSecret)) {
      throw new ValidationError('启用 tenant OIDC 时必须提供 issuerUrl、clientId、clientSecret', ErrorCode.VALIDATION_REQUIRED);
    }

    const oidcClientSecretEncrypted = oidcSecret
      ? this.encryptSecret(oidcSecret, kmsKeyRef)
      : '';

    if (existing) {
      this.db.prepare<void>(
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
        deploymentMode,
        databaseIsolationMode,
        kafkaNamespace ?? '',
        encryptionMode,
        kmsKeyRef,
        oidcEnabled ? 1 : 0,
        oidcIssuerUrl,
        oidcClientId,
        oidcClientSecretEncrypted,
        oidcAudience,
        oidcScope,
        oidcEmailClaim,
        oidcNameClaim,
        now,
        tenantId,
      );
    } else {
      this.db.prepare<void>(
        `INSERT INTO tenant_enterprise_profiles (
          tenant_id, deployment_mode, database_isolation_mode, kafka_namespace,
          encryption_mode, kms_key_ref, scim_token_hash,
          oidc_enabled, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted,
          oidc_audience, oidc_scope, oidc_email_claim, oidc_name_claim,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        tenantId,
        deploymentMode,
        databaseIsolationMode,
        kafkaNamespace ?? '',
        encryptionMode,
        kmsKeyRef,
        oidcEnabled ? 1 : 0,
        oidcIssuerUrl,
        oidcClientId,
        oidcClientSecretEncrypted,
        oidcAudience,
        oidcScope,
        oidcEmailClaim,
        oidcNameClaim,
        now,
        now,
      );
    }

    return this.getProfile(tenantId);
  }

  storeScimToken(tenantId: string, token: string): void {
    const existing = this.getRow(tenantId);
    const now = Date.now();
    const tokenHash = hashToken(token);
    if (existing) {
      this.db.prepare<void>(
        'UPDATE tenant_enterprise_profiles SET scim_token_hash = ?, updated_at = ? WHERE tenant_id = ?',
      ).run(tokenHash, now, tenantId);
      return;
    }

    this.db.prepare<void>(
      `INSERT INTO tenant_enterprise_profiles (
        tenant_id, deployment_mode, database_isolation_mode, kafka_namespace,
        encryption_mode, kms_key_ref, scim_token_hash,
        oidc_enabled, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted,
        oidc_audience, oidc_scope, oidc_email_claim, oidc_name_claim,
        created_at, updated_at
      ) VALUES (?, 'shared_cluster', 'shared', '', 'platform_managed', NULL, ?, 0, '', '', '', '', 'openid profile email', 'email', 'name', ?, ?)`,
    ).run(tenantId, tokenHash, now, now);
  }

  resolveScimTenant(token: string): { tenantId: string } | null {
    const row = this.db.prepare<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_enterprise_profiles WHERE scim_token_hash = ? LIMIT 1',
    ).get(hashToken(token));
    if (!row) return null;
    return { tenantId: row.tenant_id };
  }

  getEffectiveOidcConfig(tenantId: string): EffectiveOidcConfig | null {
    const row = this.getRow(tenantId);
    const profile = row ? toProfile(row) : null;
    const base = this.config.oidc;
    const enabled = profile?.oidc.enabled || base.enabled;
    if (!enabled) return null;

    const clientSecret = row?.oidc_client_secret_encrypted
      ? this.decryptSecret(row.oidc_client_secret_encrypted)
      : base.clientSecret;

    const effective: EffectiveOidcConfig = {
      issuerUrl: row?.oidc_issuer_url || base.issuerUrl,
      clientId: row?.oidc_client_id || base.clientId,
      clientSecret,
      audience: row?.oidc_audience || base.audience,
      scope: row?.oidc_scope || base.scope,
      emailClaim: row?.oidc_email_claim || base.emailClaim,
      nameClaim: row?.oidc_name_claim || base.nameClaim,
    };

    if (!effective.issuerUrl || !effective.clientId || !effective.clientSecret) {
      return null;
    }

    return effective;
  }

  getTenantEncryption(tenantId: string): FieldEncryption | undefined {
    if (!this.config.encryption.enabled) return undefined;
    const profile = this.getProfile(tenantId);
    const keyRef = profile.kmsKeyRef ?? this.config.encryption.defaultKeyRef;
    this.assertKnownKeyRef(keyRef);
    return new FieldEncryption({
      ...this.config.encryption,
      defaultKeyRef: keyRef ?? this.config.encryption.defaultKeyRef,
    });
  }

  private getRow(tenantId: string): TenantEnterpriseProfileRow | undefined {
    return this.db.prepare<TenantEnterpriseProfileRow>(
      'SELECT * FROM tenant_enterprise_profiles WHERE tenant_id = ? LIMIT 1',
    ).get(tenantId);
  }

  private encryptSecret(secret: string, keyRef: string | null): string {
    if (!this.config.encryption.enabled) return secret;
    const encryption = new FieldEncryption({
      ...this.config.encryption,
      defaultKeyRef: keyRef ?? this.config.encryption.defaultKeyRef,
    });
    return encryption.encrypt(secret);
  }

  private decryptSecret(ciphertext: string): string {
    if (!ciphertext) return '';
    if (!this.config.encryption.enabled) return ciphertext;
    const encryption = new FieldEncryption(this.config.encryption);
    try {
      return encryption.decrypt(ciphertext);
    } catch {
      return ciphertext;
    }
  }

  private assertKnownKeyRef(keyRef: string | null): void {
    if (!this.config.encryption.enabled) return;
    if (!keyRef || keyRef === 'master') return;
    if (!(keyRef in this.config.encryption.keyring)) {
      throw new ValidationError(`未知的 kmsKeyRef: ${keyRef}`, ErrorCode.VALIDATION_FORMAT);
    }
  }
}
