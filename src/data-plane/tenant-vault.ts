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

/**
 * 加载平台根密钥（用于派生每租户的 wrap/sign 子密钥）。
 *
 * **绝不能在缺失时随机生成**（审计 Critical）：根密钥进程内随机 → 首次启动能正常
 * wrap 数据密钥，重启后根密钥变了，历史密文的 GCM 校验必然失败且**永久不可恢复**。
 * 这是静默的数据损毁——启动看起来成功，损失在下一次读取时才暴露。
 *
 * 故：生产/预发环境缺失即拒绝启动（fail-closed）。仅在**测试运行器进程内**允许回退到
 * 固定测试密钥——固定而非随机，保证同进程多次实例化行为一致，也不会掩盖生产配置缺失。
 * 用 NODE_TEST_CONTEXT（node --test 自动注入）判定，不依赖调用方设置 NODE_ENV。
 */
function isNodeTestRunner(): boolean {
  return process.env.NODE_TEST_CONTEXT !== undefined || process.env.NODE_ENV === 'test';
}

function loadPlatformKey(): Buffer {
  const envKey = process.env.CHRONO_PLATFORM_KEY;
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error('CHRONO_PLATFORM_KEY must be a 32-byte hex string');
    }
    return Buffer.from(envKey, 'hex');
  }
  if (isNodeTestRunner()) {
    /* 固定测试密钥：可复现、跨重启一致；绝不用于生产（无 env 时生产直接拒启）。 */
    return Buffer.from('test'.repeat(16), 'utf8').subarray(0, 32);
  }
  throw new Error(
    'CHRONO_PLATFORM_KEY 未设置：平台根密钥缺失时若随机生成，重启后既有密文将永久不可解密。'
    + '请提供持久化的 32 字节 hex 根密钥（或由 KMS 注入）后再启动。',
  );
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
