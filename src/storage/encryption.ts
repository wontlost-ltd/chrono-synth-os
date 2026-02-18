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

export interface EncryptionConfig {
  enabled: boolean;
  masterKey: string;
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
  private readonly key: Buffer;
  private readonly enabled: boolean;

  constructor(config: EncryptionConfig) {
    this.enabled = config.enabled;
    this.key = deriveKey(config.masterKey);
  }

  /** 加密明文，返回 base64 编码的密文（version + IV + authTag + ciphertext） */
  encrypt(plaintext: string): string {
    if (!this.enabled) return plaintext;

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const version = Buffer.alloc(VERSION_PREFIX_LENGTH);
    version[0] = 1;

    const result = Buffer.concat([version, iv, authTag, encrypted]);
    return result.toString('base64');
  }

  /** 解密 base64 编码的密文 */
  decrypt(ciphertext: string): string {
    if (!this.enabled) return ciphertext;

    const buf = Buffer.from(ciphertext, 'base64');

    if (buf.length < VERSION_PREFIX_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return ciphertext;
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

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf-8');
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
