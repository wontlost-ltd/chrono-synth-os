/**
 * 快照存储 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const SNAP_QUERY_BY_ID = 'snapshot.byId' as const;
export const SNAP_QUERY_LATEST = 'snapshot.latest' as const;
export const SNAP_QUERY_LIST = 'snapshot.list' as const;

/* ── Command Kinds ── */

export const SNAP_CMD_SAVE = 'snapshot.save' as const;
export const SNAP_CMD_DELETE = 'snapshot.delete' as const;
export const EVO_CMD_PERSIST = 'evolution.persist' as const;

/* ── 行类型 ── */

export interface SnapshotRow {
  readonly id: string;
  readonly data_json: string;
  readonly reason: string;
  readonly created_at: number;
}

/** 摘要行（不含 data_json，用于列表展示） */
export interface SnapshotSummaryRow {
  readonly id: string;
  readonly reason: string;
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface SnapSaveParams {
  id: string;
  dataJson: string;
  reason: string;
  createdAt: number;
}

export interface EvoPersistParams {
  id: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  mergedVersionIdsJson: string;
  valueDeltaJson: string;
  evolvedAt: number;
  diffReportJson: string | null;
}

/* ── Query 工厂 ── */

export function snapQueryById(id: string): Query<SnapshotRow | null, string> {
  return { kind: SNAP_QUERY_BY_ID, params: id };
}

export function snapQueryLatest(): Query<SnapshotRow | null, void> {
  return { kind: SNAP_QUERY_LATEST, params: undefined as unknown as void };
}

export function snapQueryList(): Query<SnapshotSummaryRow, void> {
  return { kind: SNAP_QUERY_LIST, params: undefined as unknown as void };
}

/* ── Command 工厂 ── */

export function snapCmdSave(params: SnapSaveParams): Command<SnapSaveParams> {
  return { kind: SNAP_CMD_SAVE, params };
}

export function snapCmdDelete(id: string): Command<string> {
  return { kind: SNAP_CMD_DELETE, params: id };
}

export function evoCmdPersist(params: EvoPersistParams): Command<EvoPersistParams> {
  return { kind: EVO_CMD_PERSIST, params };
}
