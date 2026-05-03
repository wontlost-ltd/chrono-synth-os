import type { FieldCrypto } from '@chrono/data-plane';
import { FieldEncryption, type EncryptionConfig } from './encryption.js';

export class NodeFieldCrypto implements FieldCrypto {
  private readonly enc: FieldEncryption;

  constructor(config: EncryptionConfig) {
    this.enc = new FieldEncryption(config);
  }

  async encrypt(input: { plaintext: string; tenantId: string; keyRef?: string }): Promise<string> {
    return this.enc.encrypt(input.plaintext, input.keyRef);
  }

  async decrypt(input: { ciphertext: string; tenantId: string }): Promise<string> {
    return this.enc.decrypt(input.ciphertext);
  }

  async isEnabled(_tenantId: string): Promise<boolean> {
    return this.enc.isEnabled;
  }
}

export class NoopFieldCrypto implements FieldCrypto {
  async encrypt(input: { plaintext: string; tenantId: string; keyRef?: string }): Promise<string> {
    return input.plaintext;
  }

  async decrypt(input: { ciphertext: string; tenantId: string }): Promise<string> {
    return input.ciphertext;
  }

  async isEnabled(_tenantId: string): Promise<boolean> {
    return false;
  }
}
