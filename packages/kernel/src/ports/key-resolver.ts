/**
 * 密钥管理适配器契约
 * 抽象各运行时的密钥解析、轮换与撤销操作
 */

/** 密钥句柄 — 引用已解析的密钥实例 */
export interface KeyHandle {
  readonly keyRef: string;
  readonly algorithm: string;
}

/** 密钥轮换结果 */
export interface KeyRotationResult {
  readonly previousKeyRef: string;
  readonly newKeyRef: string;
  readonly algorithm: string;
}

/** 密钥解析器 — 支持加密/解密/重包装三种用途 */
export interface KeyResolver {
  resolve(keyRef: string, purpose: 'encrypt' | 'decrypt' | 'rewrap'): Promise<KeyHandle>;
  rotate(keyRef: string): Promise<KeyRotationResult>;
  revoke(keyRef: string): Promise<void>;
}
