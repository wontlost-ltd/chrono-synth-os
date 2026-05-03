import type { IDatabase } from '../storage/database.js';

export interface StorageProviderResolver {
  resolveTenantStorage(tenantId: string): Promise<{
    provider: 'platform' | 's3' | 'gcs' | 'azure_blob' | 'local';
    bucketOrPath: string;
    region?: string;
    encryptionKeyRef?: string;
  }>;
}

type StorageProvider = 'platform' | 's3' | 'gcs' | 'azure_blob' | 'local';

interface StorageBindingRow {
  provider: StorageProvider;
  bucket_or_path: string;
  region: string | null;
  encryption_key_ref: string | null;
}

export function createStorageProviderResolver(db: IDatabase): StorageProviderResolver {
  return {
    async resolveTenantStorage(tenantId) {
      const row = db
        .prepare<StorageBindingRow>(
          `SELECT provider, bucket_or_path, region, encryption_key_ref
           FROM tenant_storage_bindings
           WHERE tenant_id = ?`,
        )
        .get(tenantId);

      if (!row) {
        return {
          provider: 'platform',
          bucketOrPath: 'platform',
        };
      }

      return {
        provider: row.provider,
        bucketOrPath: row.bucket_or_path,
        region: row.region ?? undefined,
        encryptionKeyRef: row.encryption_key_ref ?? undefined,
      };
    },
  };
}
