import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { realClock, type Clock } from '../utils/clock.js';

export type KmsProvider = 'platform' | 'aws_kms' | 'gcp_kms' | 'azure_key_vault' | 'external';

export interface TenantVault {
  wrapDataKey(input: { tenantId: string; keyRef: string; plaintextDataKey: Uint8Array }): Promise<{ wrappedDataKey: Uint8Array; keyVersion: number }>;
  unwrapDataKey(input: { tenantId: string; keyRef: string; wrappedDataKey: Uint8Array }): Promise<Uint8Array>;
  sign(input: { tenantId: string; keyRef: string; payload: Uint8Array }): Promise<{ signature: Uint8Array; algorithm: string; keyVersion: number }>;
  verify(input: { tenantId: string; keyRef: string; payload: Uint8Array; signature: Uint8Array }): Promise<boolean>;
}

interface KeyVersionRow {
  version: number;
  status: string;
}

const PLATFORM_PROVIDER: KmsProvider = 'platform';
const AES_GCM_IV_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const HMAC_ALGORITHM = 'HMAC-SHA256';
const PLATFORM_KEY = loadPlatformKey();

export function createPlatformTenantVault(db: IDatabase, clock: Clock = realClock): TenantVault {
  return new PlatformTenantVault(db, clock);
}

class PlatformTenantVault implements TenantVault {
  /* 时钟抽象（确定性）：密钥版本创建/审计时间戳须可注入以便测试控制与 SLA 验证。 */
  constructor(private readonly db: IDatabase, private readonly clock: Clock = realClock) {}

  async wrapDataKey(input: { tenantId: string; keyRef: string; plaintextDataKey: Uint8Array }): Promise<{ wrappedDataKey: Uint8Array; keyVersion: number }> {
    return this.withAudit('wrapDataKey', input.tenantId, input.keyRef, async () => {
      const keyVersion = this.getOrCreateActiveKeyVersion(input.tenantId, input.keyRef).version;
      const wrappingKey = derivePlatformKey(input.tenantId, input.keyRef, keyVersion, 'wrap');
      const iv = randomBytes(AES_GCM_IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv, { authTagLength: AES_GCM_TAG_LENGTH });
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(input.plaintextDataKey)),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        wrappedDataKey: Buffer.concat([iv, tag, ciphertext]),
        keyVersion,
      };
    });
  }

  async unwrapDataKey(input: { tenantId: string; keyRef: string; wrappedDataKey: Uint8Array }): Promise<Uint8Array> {
    return this.withAudit('unwrapDataKey', input.tenantId, input.keyRef, async () => {
      const keyVersion = this.getLatestUsableKeyVersion(input.tenantId, input.keyRef).version;
      const wrapped = Buffer.from(input.wrappedDataKey);
      if (wrapped.length <= AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH) {
        throw new Error('wrapped data key is malformed');
      }
      const iv = wrapped.subarray(0, AES_GCM_IV_LENGTH);
      const tag = wrapped.subarray(AES_GCM_IV_LENGTH, AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH);
      const ciphertext = wrapped.subarray(AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH);
      const wrappingKey = derivePlatformKey(input.tenantId, input.keyRef, keyVersion, 'wrap');
      const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv, { authTagLength: AES_GCM_TAG_LENGTH });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    });
  }

  async sign(input: { tenantId: string; keyRef: string; payload: Uint8Array }): Promise<{ signature: Uint8Array; algorithm: string; keyVersion: number }> {
    return this.withAudit('sign', input.tenantId, input.keyRef, async () => {
      const keyVersion = this.getOrCreateActiveKeyVersion(input.tenantId, input.keyRef).version;
      const signingKey = derivePlatformKey(input.tenantId, input.keyRef, keyVersion, 'sign');
      const signature = createHmac('sha256', signingKey).update(Buffer.from(input.payload)).digest();
      return { signature, algorithm: HMAC_ALGORITHM, keyVersion };
    });
  }

  async verify(input: { tenantId: string; keyRef: string; payload: Uint8Array; signature: Uint8Array }): Promise<boolean> {
    return this.withAudit('verify', input.tenantId, input.keyRef, async () => {
      const keyVersion = this.getLatestUsableKeyVersion(input.tenantId, input.keyRef).version;
      const signingKey = derivePlatformKey(input.tenantId, input.keyRef, keyVersion, 'sign');
      const expected = createHmac('sha256', signingKey).update(Buffer.from(input.payload)).digest();
      const actual = Buffer.from(input.signature);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
  }

  private getOrCreateActiveKeyVersion(tenantId: string, keyRef: string): KeyVersionRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tenant_key_versions(id, tenant_id, key_ref, provider, version, status, created_at)
         VALUES(?, ?, ?, ?, 1, 'active', ?)`,
      )
      .run(randomUUID(), tenantId, keyRef, PLATFORM_PROVIDER, this.clock.now());
    return this.getLatestUsableKeyVersion(tenantId, keyRef);
  }

  private getLatestUsableKeyVersion(tenantId: string, keyRef: string): KeyVersionRow {
    const row = this.db
      .prepare<KeyVersionRow>(
        `SELECT version, status
         FROM tenant_key_versions
         WHERE tenant_id = ? AND key_ref = ? AND provider = ?
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(tenantId, keyRef, PLATFORM_PROVIDER);
    if (!row) {
      throw new Error(`unknown key: ${keyRef}`);
    }
    if (row.status === 'revoked') {
      throw new Error(`key revoked: ${keyRef}`);
    }
    return row;
  }

  private async withAudit<T>(
    operation: string,
    tenantId: string,
    keyRef: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let keyVersion: number | null = null;
    try {
      const result = await fn();
      keyVersion = this.readLatestKeyVersion(tenantId, keyRef);
      this.writeAudit(tenantId, operation, keyRef, keyVersion, 'success');
      return result;
    } catch (error) {
      keyVersion = this.readLatestKeyVersion(tenantId, keyRef);
      const message = error instanceof Error ? error.message : String(error);
      this.writeAudit(tenantId, operation, keyRef, keyVersion, 'failure', message);
      throw error;
    }
  }

  private readLatestKeyVersion(tenantId: string, keyRef: string): number | null {
    const row = this.db
      .prepare<{ version: number }>(
        `SELECT version
         FROM tenant_key_versions
         WHERE tenant_id = ? AND key_ref = ? AND provider = ?
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(tenantId, keyRef, PLATFORM_PROVIDER);
    return row?.version ?? null;
  }

  private writeAudit(
    tenantId: string,
    operation: string,
    keyRef: string,
    keyVersion: number | null,
    outcome: 'success' | 'failure',
    errorMessage?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO tenant_vault_audit(id, tenant_id, operation, key_ref, key_version, outcome, error_message, performed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), tenantId, operation, keyRef, keyVersion, outcome, errorMessage ?? null, this.clock.now());
  }
}

function loadPlatformKey(): Buffer {
  const envKey = process.env.CHRONO_PLATFORM_KEY;
  if (!envKey) return randomBytes(32);
  if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
    throw new Error('CHRONO_PLATFORM_KEY must be a 32-byte hex string');
  }
  return Buffer.from(envKey, 'hex');
}

function derivePlatformKey(tenantId: string, keyRef: string, keyVersion: number, purpose: 'wrap' | 'sign'): Buffer {
  return createHmac('sha256', PLATFORM_KEY)
    .update(purpose)
    .update('\0')
    .update(tenantId)
    .update('\0')
    .update(keyRef)
    .update('\0')
    .update(String(keyVersion))
    .digest();
}
