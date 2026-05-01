import { createHash } from 'node:crypto';
import type { SyncWriteUnitOfWork, TprofRow } from '@chrono/kernel';
import {
  tprofQueryByTenant, tprofQueryByScimToken,
  tprofCmdUpdate, tprofCmdInsert,
  tprofCmdUpdateScimToken, tprofCmdInsertWithScimToken,
} from '@chrono/kernel';
import { TenantManifestV1Schema } from '@chrono/contracts';
import type { TenantManifestV1 } from '@chrono/contracts';
import type { AppConfig } from '../config/schema.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import type { IDatabase } from '../storage/database.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { FieldEncryption } from '../storage/encryption.js';
import {
  assertValidKafkaNamespace,
  defaultKafkaNamespaceForTenant,
  normalizeKafkaNamespace,
} from './tenant-kafka-topics.js';

type DeploymentMode = 'shared_cluster' | 'dedicated_db';
type DatabaseIsolationMode = 'shared' | 'dedicated';
type EncryptionMode = 'platform_managed' | 'tenant_dedicated';

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

type KmsProvider = 'platform' | 'aws_kms' | 'gcp_kms' | 'azure_kv' | 'vault';

function inferKmsProvider(keyRef: string | null): KmsProvider {
  if (!keyRef) return 'platform';
  if (keyRef.startsWith('arn:aws:kms:')) return 'aws_kms';
  if (keyRef.startsWith('projects/') && keyRef.includes('/cryptoKeyVersions/')) return 'gcp_kms';
  if (keyRef.startsWith('https://') && keyRef.includes('.vault.azure.net/')) return 'azure_kv';
  if (keyRef.startsWith('vault:')) return 'vault';
  return 'platform';
}

function profileToManifestV1(
  tenantId: string,
  profile: TenantEnterpriseProfile,
  config: AppConfig,
): TenantManifestV1 {
  const deploymentMode =
    profile.deploymentMode === 'dedicated_db' ? 'dedicated_db' : 'shared_cluster';

  const encryptionMode = profile.encryptionMode;
  const kmsProvider: KmsProvider =
    encryptionMode === 'tenant_dedicated'
      ? inferKmsProvider(profile.kmsKeyRef)
      : 'platform';

  const storage = config.db.connectionString
    ? { primary: config.db.connectionString }
    : { primary: config.db.path };

  return TenantManifestV1Schema.parse({
    schemaVersion: 'tenant-manifest.v1',
    tenantId,
    region: config.region,
    deploymentMode,
    encryptionMode,
    storage,
    kms: {
      provider: kmsProvider,
      ...(profile.kmsKeyRef ? { keyRef: profile.kmsKeyRef } : {}),
    },
    sync: {},
    retention: {},
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toProfile(row: TprofRow | null | undefined): TenantEnterpriseProfile {
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
    deploymentMode: row.deployment_mode as DeploymentMode,
    databaseIsolationMode: row.database_isolation_mode as DatabaseIsolationMode,
    kafkaNamespace: normalizeOptionalString(row.kafka_namespace),
    encryptionMode: row.encryption_mode as EncryptionMode,
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
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    db: IDatabase,
    private readonly config: AppConfig,
  ) {
    registerCoreSelfExecutors();
    this.tx = directUnitOfWork(db);
  }

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

    const cmdParams = {
      tenantId,
      deploymentMode,
      databaseIsolationMode,
      kafkaNamespace: kafkaNamespace ?? '',
      encryptionMode,
      kmsKeyRef,
      oidcEnabled: oidcEnabled ? 1 : 0,
      oidcIssuerUrl,
      oidcClientId,
      oidcClientSecretEncrypted,
      oidcAudience,
      oidcScope,
      oidcEmailClaim,
      oidcNameClaim,
      now,
    };

    if (existing) {
      this.tx.execute(tprofCmdUpdate(cmdParams));
    } else {
      this.tx.execute(tprofCmdInsert(cmdParams));
    }

    return this.getProfile(tenantId);
  }

  storeScimToken(tenantId: string, token: string): void {
    const existing = this.getRow(tenantId);
    const now = Date.now();
    const tokenHash = hashToken(token);
    if (existing) {
      this.tx.execute(tprofCmdUpdateScimToken({ tenantId, tokenHash, now }));
      return;
    }

    this.tx.execute(tprofCmdInsertWithScimToken({ tenantId, tokenHash, now }));
  }

  resolveScimTenant(token: string): { tenantId: string } | null {
    const row = this.tx.queryOne(tprofQueryByScimToken(hashToken(token)));
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

  getManifest(tenantId: string): TenantManifestV1 {
    const profile = this.getProfile(tenantId);
    return profileToManifestV1(tenantId, profile, this.config);
  }

  getTenantEncryption(tenantId: string): FieldEncryption | undefined {
    if (!this.config.encryption.enabled) return undefined;
    const manifest = this.getManifest(tenantId);
    const keyRef = manifest.kms.keyRef ?? this.config.encryption.defaultKeyRef;
    this.assertKnownKeyRef(keyRef);
    return new FieldEncryption({
      ...this.config.encryption,
      defaultKeyRef: keyRef ?? this.config.encryption.defaultKeyRef,
    });
  }

  private getRow(tenantId: string): TprofRow | null {
    return this.tx.queryOne(tprofQueryByTenant(tenantId));
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
