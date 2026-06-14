/**
 * 感知媒体引用存储（ADR-0052 Edge-P5）— 媒体引用元数据 + retention + GDPR 擦除编排。
 *
 * 红线：**原始音视频绝不进库**。本 store 只管引用元数据（object_key/sha256/...）；原始媒体在对象
 * 存储。retention worker 按 delete_after 清理过期引用并触发对象存储 erase。
 *
 * GDPR Art.17 擦除走**两段闭环**（Codex 复审）：privacy eraseData **标记** perception_media_refs
 * 为 erased + delete_after=0（保留 object_key），retention worker（runMediaRetention）异步删对象
 * 存储对象 + 删引用行——原始媒体最终被删，不丢定位能力、无孤儿。`ObjectStorageEraser` 是可注入
 * 接口（真实 S3/R2/minio driver 部署期接入，本层 mock 证明擦除语义）。**部署契约**：retention
 * worker 是 GDPR 关键后台任务，必须运行并监控。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  mediaRefById, mediaRefByTenant, mediaRefExpired,
  mediaRefInsert, mediaRefSetStatus, mediaRefDelete,
  type PerceptionMediaRefRow,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';

/** 对象存储擦除钩子（运行时中性；真实 S3/R2/minio driver 部署期实现）。 */
export interface ObjectStorageEraser {
  /**
   * 删除对象存储中的媒体对象。**必须幂等**：对象不存在（已删/从未存在）应**视为成功 resolve**
   * （不抛 not-found）——否则 retention 重试会因孤儿调用反复失败。仅真实 IO 错误（网络/权限）才抛。
   */
  erase(objectKey: string): Promise<void>;
}

/** 媒体引用元数据（脱敏视图——不含 object_key，供导出/UI）。 */
export interface MediaRefMetadata {
  readonly id: string;
  readonly sha256: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly retentionClass: string;
  readonly status: string;
  readonly createdAt: number;
}

export interface RegisterMediaInput {
  readonly id: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly retentionClass?: string;
  /** 过期时刻（epoch ms）；undefined → 用 retentionClass 推导或永久（null）。 */
  readonly deleteAfter?: number | null;
}

export class MediaRefStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /** 登记一个媒体引用（原始媒体已在对象存储）。 */
  register(input: RegisterMediaInput, now: number): void {
    assertObjectKeyOnly(input.objectKey);   /* durable boundary：强制「原始媒体绝不进库」红线 */
    this.tx.execute(mediaRefInsert({
      id: input.id,
      tenantId: this.tenantId,
      objectKey: input.objectKey,
      sha256: input.sha256,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      durationMs: input.durationMs,
      retentionClass: input.retentionClass ?? 'process-and-delete',
      deleteAfter: input.deleteAfter ?? null,
      status: 'pending',
      createdAt: now,
    }));
  }

  /** 取某引用的 object_key（仅内部/擦除用，绝不导出）。 */
  getObjectKey(id: string): string | undefined {
    return this.tx.queryOne(mediaRefById({ id, tenantId: this.tenantId }))?.object_key ?? undefined;
  }

  /** 列本租户媒体引用元数据（**脱敏不含 object_key**，供导出/UI）。 */
  listMetadata(): MediaRefMetadata[] {
    return [...this.tx.queryMany(mediaRefByTenant(this.tenantId))].map(toMetadata);
  }

  /** 更新处理状态。 */
  setStatus(id: string, status: string): void {
    this.tx.execute(mediaRefSetStatus({ id, tenantId: this.tenantId, status }));
  }

  /**
   * 擦除一个媒体引用：**先删对象存储对象，再删 DB 行**（顺序保证——对象存储删失败则不删行，
   * 避免引用丢失但对象残留的孤儿）。eraser 失败抛错由调用方处理。
   */
  async erase(id: string, eraser: ObjectStorageEraser): Promise<boolean> {
    const objectKey = this.getObjectKey(id);
    if (objectKey === undefined) return false;
    await eraser.erase(objectKey);                                  /* 先删对象（失败则不删行）。 */
    this.tx.execute(mediaRefDelete({ id, tenantId: this.tenantId }));   /* 再删引用行。 */
    return true;
  }
}

/**
 * retention worker：清理所有租户已过期（delete_after ≤ now）的媒体引用 —— 先删对象存储对象，
 * 再删 DB 行。全局扫描（按时间，非租户数据访问）。返回清理数。单个对象删失败隔离（不阻断其他）。
 *
 * **调用契约（收口审查）**：`tx` **必须是 root/admin DB**（非 TenantDatabase）。本函数依赖
 * MEDIA_REF_QUERY_EXPIRED 全局扫描所有租户的过期引用；若误传 TenantDatabase，query 会被自动改写
 * 成单租户扫描，导致其他租户的过期媒体永不清理（合规/容量风险）。部署时由 retention worker 用
 * root DB 调用。
 */
export async function runMediaRetention(
  tx: SyncWriteUnitOfWork,
  eraser: ObjectStorageEraser,
  now: number,
): Promise<{ erased: number; failed: number }> {
  const expired = tx.queryMany(mediaRefExpired(now));
  let erased = 0;
  let failed = 0;
  for (const row of expired) {
    try {
      await eraser.erase(row.object_key);
      tx.execute(mediaRefDelete({ id: row.id, tenantId: row.tenant_id }));
      erased++;
    } catch {
      /* 单个对象删失败隔离：不删该行（下次重试），不阻断其他过期清理。 */
      failed++;
    }
  }
  return { erased, failed };
}

/** object_key 上限——对象存储 key 是路径式短标识，超长说明可能塞了内嵌内容。 */
const MAX_OBJECT_KEY_LEN = 1024;

/**
 * durable boundary 校验：object_key 必须是引用（对象存储路径），**绝不是内嵌的原始媒体内容**
 * （Codex Edge-P5 复审：原 object_key 是未校验 text，上游误传 data: URI / base64 媒体会绕过
 * 「原始媒体绝不进库」红线）。拒绝 data:/blob: URI 与超长 payload。
 */
function assertObjectKeyOnly(objectKey: string): void {
  if (typeof objectKey !== 'string' || objectKey.trim().length === 0) {
    throw new Error('perception_media_refs: object_key 不能为空');
  }
  if (objectKey.length > MAX_OBJECT_KEY_LEN) {
    throw new Error(`perception_media_refs: object_key 超长（${objectKey.length}>${MAX_OBJECT_KEY_LEN}），疑似内嵌媒体内容（红线：原始媒体绝不进库）`);
  }
  if (/^\s*(data|blob):/i.test(objectKey)) {
    throw new Error('perception_media_refs: object_key 不得是 data:/blob: URI（内嵌媒体内容违反红线）');
  }
}

function toMetadata(r: PerceptionMediaRefRow): MediaRefMetadata {
  return {
    id: r.id, sha256: r.sha256, mime: r.mime, sizeBytes: r.size_bytes,
    durationMs: r.duration_ms, retentionClass: r.retention_class, status: r.status, createdAt: r.created_at,
  };
}
