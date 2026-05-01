import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';

export type KmsProvider = 'platform' | 'aws_kms' | 'gcp_kms' | 'azure_kv' | 'vault';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface KmsEnvelopeKey {
  dataKey: Buffer;
  encryptedDataKey: string;
  keyRef: string;
  provider: KmsProvider;
  algorithm: 'aes-256-gcm';
}

export interface KmsClient {
  provider: KmsProvider;
  generateDataKey(keyRef: string): Promise<KmsEnvelopeKey>;
  unwrapDataKey(encryptedDataKey: string, keyRef: string): Promise<Buffer>;
}

function aesGcmEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function aesGcmDecrypt(payload: Buffer, key: Buffer): Buffer {
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export class PlatformKmsClient implements KmsClient {
  readonly provider: KmsProvider = 'platform';
  private readonly masterKey: Buffer;

  constructor(masterKeyB64: string) {
    const key = Buffer.from(masterKeyB64, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new Error(`masterKey 解码后必须为 ${KEY_LENGTH} 字节`);
    }
    this.masterKey = key;
  }

  async generateDataKey(keyRef: string): Promise<KmsEnvelopeKey> {
    const dataKey = randomBytes(KEY_LENGTH);
    const encryptedPayload = aesGcmEncrypt(dataKey, this.masterKey);
    return {
      dataKey,
      encryptedDataKey: encryptedPayload.toString('base64'),
      keyRef,
      provider: 'platform',
      algorithm: 'aes-256-gcm',
    };
  }

  async unwrapDataKey(encryptedDataKey: string, _keyRef: string): Promise<Buffer> {
    const payload = Buffer.from(encryptedDataKey, 'base64');
    return aesGcmDecrypt(payload, this.masterKey);
  }
}

export class AwsKmsClient implements KmsClient {
  readonly provider: KmsProvider = 'aws_kms';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getKms(): Promise<any> {
    try {
      // 动态导入，运行时可能不存在
      return await (new Function('m', 'return import(m)'))('@aws-sdk/client-kms');
    } catch {
      throw new Error('@aws-sdk/client-kms is not installed');
    }
  }

  async generateDataKey(keyRef: string): Promise<KmsEnvelopeKey> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getKms();
    const client = new mod.KMSClient({});
    const resp = await client.send(new mod.GenerateDataKeyCommand({ KeyId: keyRef, KeySpec: 'AES_256' }));
    if (!resp.Plaintext || !resp.CiphertextBlob) {
      throw new Error('AWS KMS generateDataKey 返回空数据');
    }
    return {
      dataKey: Buffer.from(resp.Plaintext as Uint8Array),
      encryptedDataKey: Buffer.from(resp.CiphertextBlob as Uint8Array).toString('base64'),
      keyRef,
      provider: 'aws_kms',
      algorithm: 'aes-256-gcm',
    };
  }

  async unwrapDataKey(encryptedDataKey: string, keyRef: string): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getKms();
    const client = new mod.KMSClient({});
    const resp = await client.send(new mod.DecryptCommand({
      KeyId: keyRef,
      CiphertextBlob: Buffer.from(encryptedDataKey, 'base64'),
    }));
    if (!resp.Plaintext) {
      throw new Error('AWS KMS decrypt 返回空数据');
    }
    return Buffer.from(resp.Plaintext as Uint8Array);
  }
}

export class GcpKmsClient implements KmsClient {
  readonly provider: KmsProvider = 'gcp_kms';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getKms(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@google-cloud/kms');
    } catch {
      throw new Error('@google-cloud/kms is not installed');
    }
  }

  async generateDataKey(keyRef: string): Promise<KmsEnvelopeKey> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getKms();
    const client = new mod.KeyManagementServiceClient();
    const dataKey = randomBytes(KEY_LENGTH);
    const [result] = await client.encrypt({ name: keyRef, plaintext: dataKey }) as [{ ciphertext?: Buffer | string }, unknown];
    if (!result.ciphertext) {
      throw new Error('GCP KMS encrypt 返回空数据');
    }
    const ciphertext = typeof result.ciphertext === 'string'
      ? Buffer.from(result.ciphertext, 'base64')
      : Buffer.from(result.ciphertext as Buffer);
    return {
      dataKey,
      encryptedDataKey: ciphertext.toString('base64'),
      keyRef,
      provider: 'gcp_kms',
      algorithm: 'aes-256-gcm',
    };
  }

  async unwrapDataKey(encryptedDataKey: string, keyRef: string): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getKms();
    const client = new mod.KeyManagementServiceClient();
    const [result] = await client.decrypt({
      name: keyRef,
      ciphertext: Buffer.from(encryptedDataKey, 'base64'),
    }) as [{ plaintext?: Buffer | string }, unknown];
    if (!result.plaintext) {
      throw new Error('GCP KMS decrypt 返回空数据');
    }
    return typeof result.plaintext === 'string'
      ? Buffer.from(result.plaintext, 'base64')
      : Buffer.from(result.plaintext as Buffer);
  }
}

export class AzureKvClient implements KmsClient {
  readonly provider: KmsProvider = 'azure_kv';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getKv(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@azure/keyvault-keys');
    } catch {
      throw new Error('@azure/keyvault-keys is not installed');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getAzureIdentity(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@azure/identity');
    } catch {
      throw new Error('@azure/identity is not installed');
    }
  }

  // keyRef 格式：https://<vault>.vault.azure.net/keys/<key-name>/<version>
  private parseKeyRef(keyRef: string): { vaultUrl: string; keyName: string } {
    const url = new URL(keyRef);
    const parts = url.pathname.split('/').filter(Boolean);
    // /keys/<name>/<version?>
    if (parts[0] !== 'keys' || !parts[1]) {
      throw new Error(`无效的 Azure Key Vault keyRef 格式: ${keyRef}`);
    }
    return { vaultUrl: url.origin, keyName: parts[1] };
  }

  async generateDataKey(keyRef: string): Promise<KmsEnvelopeKey> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kvMod: any = await this.getKv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const identityMod: any = await this.getAzureIdentity();
    const { vaultUrl, keyName } = this.parseKeyRef(keyRef);
    const credential = new identityMod.DefaultAzureCredential();
    const keyClient = new kvMod.KeyClient(vaultUrl, credential);
    const key = await keyClient.getKey(keyName);
    const cryptoClient = new kvMod.CryptographyClient(key, credential);
    const dataKey = randomBytes(KEY_LENGTH);
    const result = await cryptoClient.wrapKey('RSA-OAEP', dataKey);
    return {
      dataKey,
      encryptedDataKey: Buffer.from(result.result as Uint8Array).toString('base64'),
      keyRef,
      provider: 'azure_kv',
      algorithm: 'aes-256-gcm',
    };
  }

  async unwrapDataKey(encryptedDataKey: string, keyRef: string): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kvMod: any = await this.getKv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const identityMod: any = await this.getAzureIdentity();
    const { vaultUrl, keyName } = this.parseKeyRef(keyRef);
    const credential = new identityMod.DefaultAzureCredential();
    const keyClient = new kvMod.KeyClient(vaultUrl, credential);
    const key = await keyClient.getKey(keyName);
    const cryptoClient = new kvMod.CryptographyClient(key, credential);
    const result = await cryptoClient.unwrapKey('RSA-OAEP', Buffer.from(encryptedDataKey, 'base64'));
    return Buffer.from(result.result as Uint8Array);
  }
}

export class VaultKmsClient implements KmsClient {
  readonly provider: KmsProvider = 'vault';
  private readonly vaultAddr: string;
  private readonly vaultToken: string;

  constructor() {
    this.vaultAddr = process.env['VAULT_ADDR'] ?? 'http://127.0.0.1:8200';
    this.vaultToken = process.env['VAULT_TOKEN'] ?? '';
  }

  // keyRef 格式：vault:<mount>/<key-name>，如 vault:transit/my-key
  private parseKeyRef(keyRef: string): { mount: string; keyName: string } {
    if (!keyRef.startsWith('vault:')) {
      throw new Error(`VaultKmsClient 只接受 vault: 前缀的 keyRef，收到: ${keyRef}`);
    }
    const path = keyRef.slice('vault:'.length);
    const slashIdx = path.indexOf('/');
    if (slashIdx <= 0) {
      throw new Error(`vault keyRef 格式应为 vault:<mount>/<key-name>，收到: ${keyRef}`);
    }
    return { mount: path.slice(0, slashIdx), keyName: path.slice(slashIdx + 1) };
  }

  async generateDataKey(keyRef: string): Promise<KmsEnvelopeKey> {
    const { mount, keyName } = this.parseKeyRef(keyRef);
    const url = `${this.vaultAddr}/v1/${mount}/datakey/plaintext/${keyName}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-Vault-Token': this.vaultToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bits: 256 }),
    });
    if (!resp.ok) {
      throw new Error(`Vault datakey 请求失败: ${resp.status} ${resp.statusText}`);
    }
    const body = await resp.json() as { data: { plaintext: string; ciphertext: string } };
    return {
      dataKey: Buffer.from(body.data.plaintext, 'base64'),
      encryptedDataKey: body.data.ciphertext,
      keyRef,
      provider: 'vault',
      algorithm: 'aes-256-gcm',
    };
  }

  async unwrapDataKey(encryptedDataKey: string, keyRef: string): Promise<Buffer> {
    const { mount, keyName } = this.parseKeyRef(keyRef);
    const url = `${this.vaultAddr}/v1/${mount}/decrypt/${keyName}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-Vault-Token': this.vaultToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: encryptedDataKey }),
    });
    if (!resp.ok) {
      throw new Error(`Vault decrypt 请求失败: ${resp.status} ${resp.statusText}`);
    }
    const body = await resp.json() as { data: { plaintext: string } };
    return Buffer.from(body.data.plaintext, 'base64');
  }
}

export function createKmsClient(provider: KmsProvider, config: AppConfig): KmsClient {
  switch (provider) {
    case 'platform':
      return new PlatformKmsClient(config.encryption.masterKey);
    case 'aws_kms':
      return new AwsKmsClient();
    case 'gcp_kms':
      return new GcpKmsClient();
    case 'azure_kv':
      return new AzureKvClient();
    case 'vault':
      return new VaultKmsClient();
    default: {
      const _exhaustive: never = provider;
      throw new Error(`未知的 KMS provider: ${_exhaustive}`);
    }
  }
}
