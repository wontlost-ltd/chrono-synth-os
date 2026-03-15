/**
 * AES-256-GCM 字段级加密
 * 支持密钥轮换：新数据用最新密钥加密，旧数据可用历史密钥解密
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION_PREFIX_LENGTH = 1;
const KEY_REF_PREFIX = 'v2.';

export interface EncryptionConfig {
  enabled: boolean;
  masterKey: string;
  defaultKeyRef?: string;
  keyring?: Record<string, string>;
  keyRotationIntervalDays: number;
}

/** 从 base64 编码的密钥派生 32 字节 AES 密钥 */
function deriveKey(secretB64: string): Buffer {
  const key = Buffer.from(secretB64, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`masterKey 解码后必须为 ${KEY_LENGTH} 字节（当前 ${key.length} 字节），请提供 32 字节的 base64 编码密钥`);
  }
  return key;
}

export class FieldEncryption {
  private readonly enabled: boolean;
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly defaultKeyRef: string;

  constructor(config: EncryptionConfig) {
    this.enabled = config.enabled;
    const keys = new Map<string, Buffer>();
    keys.set('master', deriveKey(config.masterKey));
    for (const [keyRef, value] of Object.entries(config.keyring ?? {})) {
      keys.set(keyRef, deriveKey(value));
    }
    this.keys = keys;
    this.defaultKeyRef = config.defaultKeyRef ?? 'master';
    if (!this.keys.has(this.defaultKeyRef)) {
      throw new Error(`未知的 encryption.defaultKeyRef: ${this.defaultKeyRef}`);
    }
  }

  /** 加密明文，返回 base64 编码的密文（version + IV + authTag + ciphertext） */
  encrypt(plaintext: string, keyRef = this.defaultKeyRef): string {
    if (!this.enabled) return plaintext;
    const key = this.keys.get(keyRef);
    if (!key) {
      throw new Error(`未知的加密 keyRef: ${keyRef}`);
    }

    const payload = this.encryptPayload(plaintext, key);
    if (keyRef === 'master') {
      return payload.toString('base64');
    }
    return `${KEY_REF_PREFIX}${encodeURIComponent(keyRef)}.${payload.toString('base64')}`;
  }

  private encryptPayload(plaintext: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const version = Buffer.alloc(VERSION_PREFIX_LENGTH);
    version[0] = 1;

    return Buffer.concat([version, iv, authTag, encrypted]);
  }

  /** 解密 base64 编码的密文 */
  decrypt(ciphertext: string): string {
    if (!this.enabled) return ciphertext;

    if (ciphertext.startsWith(KEY_REF_PREFIX)) {
      const remainder = ciphertext.slice(KEY_REF_PREFIX.length);
      const separatorIndex = remainder.indexOf('.');
      if (separatorIndex <= 0) {
        throw new Error('无效的 keyRef 密文格式');
      }
      const keyRef = decodeURIComponent(remainder.slice(0, separatorIndex));
      const payload = remainder.slice(separatorIndex + 1);
      const key = this.keys.get(keyRef);
      if (!key) {
        throw new Error(`找不到 keyRef 对应的密钥: ${keyRef}`);
      }
      return this.decryptPayload(Buffer.from(payload, 'base64'), key, ciphertext);
    }

    const buf = Buffer.from(ciphertext, 'base64');
    const masterKey = this.keys.get('master');
    if (!masterKey) {
      throw new Error('缺少 master 密钥');
    }
    return this.decryptPayload(buf, masterKey, ciphertext);
  }

  private decryptPayload(buf: Buffer, key: Buffer, fallback: string): string {
    if (buf.length < VERSION_PREFIX_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return fallback;
    }

    const version = buf[0];
    if (version !== 1) {
      throw new Error(`不支持的加密版本: ${version}`);
    }

    let offset = VERSION_PREFIX_LENGTH;
    const iv = buf.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = buf.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const encrypted = buf.subarray(offset);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf-8');
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
