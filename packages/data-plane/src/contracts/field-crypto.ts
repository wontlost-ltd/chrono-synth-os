export interface FieldCrypto {
  encrypt(input: { plaintext: string; tenantId: string; keyRef?: string }): Promise<string>;
  decrypt(input: { ciphertext: string; tenantId: string }): Promise<string>;
  isEnabled(tenantId: string): Promise<boolean>;
}

export type FieldCryptoFactory = (tenantId: string) => FieldCrypto;
