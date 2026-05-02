import { randomBytes } from 'node:crypto';
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

  async rotate(keyRef: string): Promise<KeyRotationResult> {
    randomBytes(32); // generate new key material (caller must update AppConfig to activate)
    const newKeyRef = `${keyRef}.v${Date.now()}`;
    this.writeAudit(keyRef, 'rotate', undefined);
    return { previousKeyRef: keyRef, newKeyRef, algorithm: 'aes-256-gcm' };
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
