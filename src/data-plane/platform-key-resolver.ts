import type { KeyResolver, KeyHandle, KeyRotationResult } from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';

export interface PlatformKeyResolverConfig {
  readonly defaultKeyRef: string;
  readonly keyring: Readonly<Record<string, string>>;
  readonly masterKey?: string;
}

interface RevocationRow {
  key_ref: string;
}

export class PlatformKeyResolver implements KeyResolver {
  private readonly keyring: ReadonlyMap<string, string>;
  private readonly revokedKeys = new Set<string>();

  constructor(
    config: PlatformKeyResolverConfig,
    private readonly db: IDatabase,
  ) {
    const keyring = new Map<string, string>();
    if (config.masterKey) keyring.set('master', config.masterKey);
    for (const [ref, val] of Object.entries(config.keyring)) {
      keyring.set(ref, val);
    }
    this.keyring = keyring;
    this.loadRevokedKeysFromDb();
  }

  async resolve(keyRef: string, purpose: 'encrypt' | 'decrypt' | 'rewrap'): Promise<KeyHandle> {
    if (this.revokedKeys.has(keyRef)) {
      throw new Error(`密钥已撤销: ${keyRef}`);
    }
    if (!this.keyring.has(keyRef)) {
      throw new Error(`未知的密钥引用: ${keyRef}`);
    }
    this.writeAudit(keyRef, 'resolve', purpose);
    return { keyRef, algorithm: 'aes-256-gcm' };
  }

  /**
   * 轮换密钥——本实现**不支持**，显式拒绝。
   *
   * 为什么不是「先实现再说」：本 resolver 的 keyring 来自静态 AppConfig，进程内
   * 没有任何持久化写入路径。原实现生成 32 字节随机材料后**直接丢弃**，只返回一个
   * `${keyRef}.v${时间戳}` 的新引用——调用方若信任该返回值去加密数据，之后
   * resolve(newKeyRef) 必然抛「未知的密钥引用」，数据永久不可解。
   *
   * 静默返回不可用的引用比明确拒绝危险得多：前者要等到解密时才暴露，那时密文
   * 已经写下。故在此 fail-closed，把轮换交给真正持有密钥生命周期的外部 KMS。
   */
  async rotate(keyRef: string): Promise<KeyRotationResult> {
    this.writeAudit(keyRef, 'rotate', undefined);
    throw new Error(
      `PlatformKeyResolver 不支持密钥轮换（keyRef=${keyRef}）：` +
      '密钥环由静态配置提供，没有持久化新密钥的路径。请通过外部 KMS 轮换后更新 AppConfig.keyring。',
    );
  }

  async revoke(keyRef: string): Promise<void> {
    this.revokedKeys.add(keyRef);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO platform_key_revocations(key_ref, revoked_at) VALUES(?, ?)`,
      )
      .run(keyRef, Date.now());
    this.writeAudit(keyRef, 'revoke', undefined);
  }

  private loadRevokedKeysFromDb(): void {
    try {
      const rows = this.db
        .prepare<RevocationRow>('SELECT key_ref FROM platform_key_revocations')
        .all();
      for (const row of rows) {
        this.revokedKeys.add(row.key_ref);
      }
    } catch {
      // Table may not exist in older DBs — safe to ignore
    }
  }

  private writeAudit(
    keyRef: string,
    action: 'resolve' | 'rotate' | 'revoke',
    _purpose?: string,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO kms_key_audit(event_id, tenant_id, operation, provider, key_ref, performed_at, success)
           VALUES(?, '', ?, 'platform', ?, ?, 1)`,
        )
        .run(
          crypto.randomUUID(),
          action,
          keyRef,
          new Date().toISOString(),
        );
    } catch {
      // Audit failures must not block key operations
    }
  }
}
