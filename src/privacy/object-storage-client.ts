/**
 * 对象存储客户端抽象层
 * 支持 local（开发用）、S3/MinIO、GCS、Azure Blob 四种后端
 * 云 SDK 均通过动态导入加载，未安装时给出明确错误提示
 */

import { mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import type { AppConfig } from '../config/schema.js';

/** 对象存储客户端接口 */
export interface ObjectStorageClient {
  /** 上传 Buffer 到指定 key，返回实际存储的 key */
  upload(key: string, data: Buffer, contentType: string): Promise<string>;
  /** 生成预签名/限时下载 URL */
  presignUrl(key: string, ttlSeconds: number): Promise<string>;
  /**
   * 删除指定 key 的对象（GDPR Art.17 物理删除用）。**必须幂等**：对象不存在（已删/从未存在）
   * **视为成功 resolve**，不抛 not-found——否则 retention 重试会因孤儿调用反复失败。
   * 仅真实 IO 错误（网络/权限/配置）才抛（让上层 fail-closed 保留引用行下周期重试）。
   */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local 实现
// ---------------------------------------------------------------------------

/** 本地磁盘存储（开发/测试用途） */
export class LocalObjectStorageClient implements ObjectStorageClient {
  private readonly root: string;
  constructor(localPath: string) {
    this.root = resolve(localPath);
  }

  /**
   * 把 key 解析为 root 内的绝对路径，并强制**不得逃逸 root**——两层防护：
   *   ① 字符串 containment：resolve(root,key) 归一化 `..` 后必须落在 root 内（挡 `../`、绝对路径、前缀碰撞）。
   *   ② symlink 防护：从 root 向下逐组件 lstat，任一已存在父组件是 symlink 即抛——否则 root 内一条
   *      `link -> /outside` 符号链接会让 `key=link/x` 字符串通过却经 symlink 写/删到 root 外（Codex 复审 Medium）。
   * 任一逃逸即抛（retention 侧 per-row catch 计 failed 保留行，fail-closed，不误删）。
   * delete 比 upload/presign 破坏性更大，故防护对三方法统一施加。
   */
  private async resolveSafePath(key: string): Promise<string> {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`object storage key escapes storage root（疑似路径穿越）: ${key}`);
    }
    /* 逐组件 lstat 已存在的父路径，遇 symlink 抛（不跟随）。target 本身是文件（可为 symlink→也拒）。 */
    const rel = relative(this.root, target);
    if (rel.length > 0) {
      const parts = rel.split(sep);
      let cur = this.root;
      for (const part of parts) {
        cur = resolve(cur, part);
        try {
          const st = await lstat(cur);
          if (st.isSymbolicLink()) {
            throw new Error(`object storage key traverses a symlink（拒绝跟随符号链接逃逸 root）: ${key}`);
          }
        } catch (err) {
          /* 组件不存在（ENOENT）= 尚未创建，安全；其它错误（权限等）上抛 fail-closed。 */
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          break; /* 后续组件必然也不存在，无需继续 stat。 */
        }
      }
    }
    return target;
  }

  async upload(key: string, data: Buffer, _contentType: string): Promise<string> {
    const filePath = await this.resolveSafePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return key;
  }

  async presignUrl(key: string, _ttlSeconds: number): Promise<string> {
    return `file://${await this.resolveSafePath(key)}`;
  }

  async delete(key: string): Promise<void> {
    /* rm({ force: true }) 对不存在路径不抛——满足幂等契约；resolveSafePath 防 `..`/symlink 越界删除。 */
    await rm(await this.resolveSafePath(key), { force: true });
  }
}

// ---------------------------------------------------------------------------
// S3 实现
// ---------------------------------------------------------------------------

/** AWS S3 / S3 兼容（MinIO 等）存储 */
export class S3ObjectStorageClient implements ObjectStorageClient {
  constructor(
    private readonly bucket: string,
    private readonly region: string,
    private readonly endpoint: string,
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getS3(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@aws-sdk/client-s3');
    } catch {
      throw new Error('@aws-sdk/client-s3 is not installed');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getPresigner(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@aws-sdk/s3-request-presigner');
    } catch {
      throw new Error('@aws-sdk/s3-request-presigner is not installed');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildClient(mod: any): any {
    const clientConfig: Record<string, unknown> = {
      region: this.region || 'us-east-1',
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    };
    if (this.endpoint) {
      clientConfig.endpoint = this.endpoint;
      clientConfig.forcePathStyle = true;
    }
    return new mod.S3Client(clientConfig);
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getS3();
    const client = this.buildClient(mod);
    await client.send(new mod.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));
    return key;
  }

  async presignUrl(key: string, ttlSeconds: number): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getS3();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const presignerMod: any = await this.getPresigner();
    const client = this.buildClient(mod);
    const command = new mod.GetObjectCommand({ Bucket: this.bucket, Key: key });
    return presignerMod.getSignedUrl(client, command, { expiresIn: ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    /* S3 DeleteObject 对不存在的 key 返回成功（幂等）——满足契约，无需特判 not-found。 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getS3();
    const client = this.buildClient(mod);
    await client.send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// ---------------------------------------------------------------------------
// GCS 实现
// ---------------------------------------------------------------------------

/** Google Cloud Storage */
export class GcsObjectStorageClient implements ObjectStorageClient {
  constructor(
    private readonly bucket: string,
    private readonly projectId: string,
    private readonly keyFile: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getStorage(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@google-cloud/storage');
    } catch {
      throw new Error('@google-cloud/storage is not installed');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildBucket(): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getStorage();
    const opts: Record<string, unknown> = {};
    if (this.projectId) opts.projectId = this.projectId;
    if (this.keyFile) opts.keyFilename = this.keyFile;
    const storage = new mod.Storage(opts);
    return storage.bucket(this.bucket);
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const bucket = await this.buildBucket();
    const file = bucket.file(key);
    await file.save(data, { contentType });
    return key;
  }

  async presignUrl(key: string, ttlSeconds: number): Promise<string> {
    const bucket = await this.buildBucket();
    const file = bucket.file(key);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + ttlSeconds * 1000,
    }) as [string];
    return url;
  }

  async delete(key: string): Promise<void> {
    /* ignoreNotFound:true → 对象不存在不抛（幂等契约）。 */
    const bucket = await this.buildBucket();
    await bucket.file(key).delete({ ignoreNotFound: true });
  }
}

// ---------------------------------------------------------------------------
// Azure Blob 实现
// ---------------------------------------------------------------------------

/** Azure Blob Storage */
export class AzureBlobObjectStorageClient implements ObjectStorageClient {
  constructor(
    private readonly connectionString: string,
    private readonly container: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getBlobMod(): Promise<any> {
    try {
      return await (new Function('m', 'return import(m)'))('@azure/storage-blob');
    } catch {
      throw new Error('@azure/storage-blob is not installed');
    }
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getBlobMod();
    const serviceClient = mod.BlobServiceClient.fromConnectionString(this.connectionString);
    const containerClient = serviceClient.getContainerClient(this.container);
    const blockBlobClient = containerClient.getBlockBlobClient(key);
    await blockBlobClient.upload(data, data.length, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    return key;
  }

  async presignUrl(key: string, ttlSeconds: number): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getBlobMod();
    const serviceClient = mod.BlobServiceClient.fromConnectionString(this.connectionString);
    const containerClient = serviceClient.getContainerClient(this.container);
    const blockBlobClient = containerClient.getBlockBlobClient(key);

    const expiresOn = new Date(Date.now() + ttlSeconds * 1000);
    const sasUrl = await blockBlobClient.generateSasUrl({
      permissions: mod.BlobSASPermissions.parse('r'),
      expiresOn,
    });
    return sasUrl;
  }

  async delete(key: string): Promise<void> {
    /* deleteIfExists 对不存在的 blob 不抛（幂等契约）。 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await this.getBlobMod();
    const serviceClient = mod.BlobServiceClient.fromConnectionString(this.connectionString);
    const containerClient = serviceClient.getContainerClient(this.container);
    await containerClient.getBlockBlobClient(key).deleteIfExists();
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * 根据 AppConfig.objectStorage.provider 创建对应的存储客户端
 */
export function createObjectStorageClient(config: Pick<AppConfig, 'objectStorage'>): ObjectStorageClient {
  const cfg = config.objectStorage;

  switch (cfg.provider) {
    case 's3':
      return new S3ObjectStorageClient(
        cfg.s3Bucket,
        cfg.s3Region,
        cfg.s3Endpoint,
        cfg.s3AccessKeyId,
        cfg.s3SecretAccessKey,
      );
    case 'gcs':
      return new GcsObjectStorageClient(cfg.gcsBucket, cfg.gcsProjectId, cfg.gcsKeyFile);
    case 'azure_blob':
      return new AzureBlobObjectStorageClient(cfg.azureConnectionString, cfg.azureContainer);
    case 'local':
    default:
      return new LocalObjectStorageClient(cfg.localPath);
  }
}

export interface TenantByosConfig {
  provider: 'platform' | 's3' | 'gcs' | 'azure_blob';
  bucket?: string;
  keyPrefix?: string;
}

/**
 * 若租户配置了 BYOS，返回租户专属客户端；否则回退到平台配置。
 * 租户仅提供 provider + bucket，认证凭据来自平台 AppConfig（envelope delegation 模型）。
 */
export function createTenantObjectStorageClient(
  tenantByos: TenantByosConfig,
  platformConfig: AppConfig,
): ObjectStorageClient {
  if (!tenantByos.provider || tenantByos.provider === 'platform') {
    return createObjectStorageClient(platformConfig);
  }

  const bucket = tenantByos.bucket?.trim();
  if (!bucket) {
    return createObjectStorageClient(platformConfig);
  }

  const cfg = platformConfig.objectStorage;

  switch (tenantByos.provider) {
    case 's3':
      return new S3ObjectStorageClient(
        bucket,
        cfg.s3Region,
        cfg.s3Endpoint,
        cfg.s3AccessKeyId,
        cfg.s3SecretAccessKey,
      );
    case 'gcs':
      return new GcsObjectStorageClient(bucket, cfg.gcsProjectId, cfg.gcsKeyFile);
    case 'azure_blob':
      return new AzureBlobObjectStorageClient(cfg.azureConnectionString, bucket);
    default:
      return createObjectStorageClient(platformConfig);
  }
}
