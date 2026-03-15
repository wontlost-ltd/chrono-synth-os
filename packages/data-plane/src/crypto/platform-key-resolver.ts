/**
 * Platform Key Resolver — 可移植接口定义
 * Node Runtime 实现位于 src/storage/，此处仅定义契约扩展
 */

/** 加密配置 — 描述平台密钥管理参数 */
export interface EncryptionConfig {
  readonly defaultKeyRef: string;
  readonly keyring: Readonly<Record<string, string>>;
  readonly algorithm?: string;
}

/** 密钥版本元数据 */
export interface KeyVersionMeta {
  readonly keyRef: string;
  readonly version: number;
  readonly algorithm: string;
  readonly createdAt: number;
  readonly status: 'active' | 'decrypt_only' | 'revoked';
}

/** 密钥审计事件 */
export interface KeyAuditEntry {
  readonly keyRef: string;
  readonly action: 'resolve' | 'rotate' | 'revoke';
  readonly purpose?: 'encrypt' | 'decrypt' | 'rewrap';
  readonly occurredAt: number;
  readonly actorId?: string;
}
