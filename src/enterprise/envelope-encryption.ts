import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { KmsClient } from './kms-client.js';
import { auditKeyOperation } from './kms-key-audit.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENVELOPE_PREFIX = 'env.v1.';

// 密文格式：env.v1.<base64(encryptedDataKey)>.<base64(iv+authTag+ciphertext)>

function aesGcmEncryptPayload(plaintext: string, dataKey: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function aesGcmDecryptPayload(payload: Buffer, dataKey: Buffer): string {
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, dataKey, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

export class EnvelopeEncryption {
  constructor(
    private readonly kmsClient: KmsClient,
    private readonly db: IDatabase,
    private readonly tenantId: string,
    private readonly keyRef: string,
  ) {}

  async encrypt(plaintext: string): Promise<string> {
    let envelopeKey;
    try {
      envelopeKey = await this.kmsClient.generateDataKey(this.keyRef);
      auditKeyOperation(this.db, {
        tenantId: this.tenantId,
        operation: 'generate',
        provider: this.kmsClient.provider,
        keyRef: this.keyRef,
        success: true,
      });
    } catch (err) {
      auditKeyOperation(this.db, {
        tenantId: this.tenantId,
        operation: 'generate',
        provider: this.kmsClient.provider,
        keyRef: this.keyRef,
        success: false,
        errorCode: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const payload = aesGcmEncryptPayload(plaintext, envelopeKey.dataKey);
    const encKeyB64 = envelopeKey.encryptedDataKey;
    const payloadB64 = payload.toString('base64');
    return `${ENVELOPE_PREFIX}${encKeyB64}.${payloadB64}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith(ENVELOPE_PREFIX)) {
      throw new Error(`无效的信封密文格式，缺少前缀 ${ENVELOPE_PREFIX}`);
    }
    const body = ciphertext.slice(ENVELOPE_PREFIX.length);
    const dotIdx = body.indexOf('.');
    if (dotIdx <= 0) {
      throw new Error('无效的信封密文格式，缺少分隔符');
    }
    const encryptedDataKey = body.slice(0, dotIdx);
    const payloadB64 = body.slice(dotIdx + 1);

    let dataKey: Buffer;
    try {
      dataKey = await this.kmsClient.unwrapDataKey(encryptedDataKey, this.keyRef);
      auditKeyOperation(this.db, {
        tenantId: this.tenantId,
        operation: 'unwrap',
        provider: this.kmsClient.provider,
        keyRef: this.keyRef,
        success: true,
      });
    } catch (err) {
      auditKeyOperation(this.db, {
        tenantId: this.tenantId,
        operation: 'unwrap',
        provider: this.kmsClient.provider,
        keyRef: this.keyRef,
        success: false,
        errorCode: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const payload = Buffer.from(payloadB64, 'base64');
    return aesGcmDecryptPayload(payload, dataKey);
  }
}
