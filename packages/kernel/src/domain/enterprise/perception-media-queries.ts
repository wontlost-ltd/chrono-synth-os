/**
 * 感知媒体引用的 Query/Command kind 契约（ADR-0052 Edge-P5）。
 *
 * kernel 只声明形状；执行器在 src/storage/executors。**原始媒体绝不进库**——本表只存对象存储
 * 引用元数据（object_key/sha256/mime/size/duration/retention/delete_after/status）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const MEDIA_REF_QUERY_BY_ID = 'perceptionMediaRef.byId' as const;
export const MEDIA_REF_QUERY_BY_TENANT = 'perceptionMediaRef.byTenant' as const;
export const MEDIA_REF_QUERY_EXPIRED = 'perceptionMediaRef.expired' as const;
export const MEDIA_REF_CMD_INSERT = 'perceptionMediaRef.insert' as const;
export const MEDIA_REF_CMD_SET_STATUS = 'perceptionMediaRef.setStatus' as const;
export const MEDIA_REF_CMD_DELETE = 'perceptionMediaRef.delete' as const;

/* ── Row ── */

export interface PerceptionMediaRefRow {
  readonly id: string;
  readonly tenant_id: string;
  /** 对象存储定位键（导出时脱敏不返回——能定位媒体）。 */
  readonly object_key: string;
  readonly sha256: string;
  readonly mime: string;
  readonly size_bytes: number;
  readonly duration_ms: number;
  readonly retention_class: string;
  readonly delete_after: number | null;
  readonly status: string;
  readonly created_at: number;
}

/* ── Params ── */

export interface MediaRefInsertParams {
  id: string;
  tenantId: string;
  objectKey: string;
  sha256: string;
  mime: string;
  sizeBytes: number;
  durationMs: number;
  retentionClass: string;
  deleteAfter: number | null;
  status: string;
  createdAt: number;
}

export interface MediaRefSetStatusParams {
  id: string;
  tenantId: string;
  status: string;
}

export interface MediaRefByIdParams {
  id: string;
  tenantId: string;
}

/* ── 工厂 ── */

/** 取某租户某媒体引用。 */
export function mediaRefById(params: MediaRefByIdParams): Query<PerceptionMediaRefRow | null, MediaRefByIdParams> {
  return { kind: MEDIA_REF_QUERY_BY_ID, params };
}

/** 列某租户全部媒体引用（GDPR 导出；调用方脱敏不返回 object_key）。 */
export function mediaRefByTenant(tenantId: string): Query<PerceptionMediaRefRow, string> {
  return { kind: MEDIA_REF_QUERY_BY_TENANT, params: tenantId };
}

/** 取已过期（delete_after ≤ now）的媒体引用（retention worker 用）。 */
export function mediaRefExpired(now: number): Query<PerceptionMediaRefRow, number> {
  return { kind: MEDIA_REF_QUERY_EXPIRED, params: now };
}

/** 插入媒体引用元数据（原始媒体已在对象存储）。 */
export function mediaRefInsert(params: MediaRefInsertParams): Command<MediaRefInsertParams> {
  return { kind: MEDIA_REF_CMD_INSERT, params };
}

/** 更新处理状态（pending→processed→erased）。 */
export function mediaRefSetStatus(params: MediaRefSetStatusParams): Command<MediaRefSetStatusParams> {
  return { kind: MEDIA_REF_CMD_SET_STATUS, params };
}

/** 删除媒体引用（retention/GDPR 擦除；对象存储 erase 由调用方在删行后触发）。 */
export function mediaRefDelete(params: MediaRefByIdParams): Command<MediaRefByIdParams> {
  return { kind: MEDIA_REF_CMD_DELETE, params };
}
