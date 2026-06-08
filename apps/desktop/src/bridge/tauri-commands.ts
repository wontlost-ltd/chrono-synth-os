import { invoke } from '@tauri-apps/api/core';
import { RuntimeSyncStateV2Schema, type RuntimeSyncStateV2 } from '@chrono/contracts';

export interface PersonaRow {
  persona_id: string;
  display_name: string;
  status: string;
  visibility: string;
  growth_index: number;
  reputation: number;
  wallet_id: string | null;
  wallet_balance: number | null;
  updated_at: string;
  synced_at: number;
}

export interface SyncStateRow {
  id: string;
  state: RuntimeSyncStateV2;
  network_online: boolean;
  auth_valid: boolean;
  remote_reachable: boolean;
  pending_push_count: number;
  conflict_count: number;
  last_sync_at: number | null;
  last_error: string | null;
  updated_at: number;
}

function assertSyncStateRow(raw: SyncStateRow): SyncStateRow {
  return {
    ...raw,
    state: RuntimeSyncStateV2Schema.parse(raw.state),
  };
}

export async function openDatabase(): Promise<void> {
  return invoke<void>('open_database');
}

export async function queryPersonas(): Promise<PersonaRow[]> {
  return invoke<PersonaRow[]>('query_personas');
}

export async function getSyncState(): Promise<SyncStateRow> {
  const raw = await invoke<SyncStateRow>('get_sync_state');
  return assertSyncStateRow(raw);
}

export async function forceSync(): Promise<void> {
  return invoke<void>('force_sync');
}

/* ── P2.1 / P3.4: memories + offline queue ───────────────────────── */

export interface MemoryNodeRow {
  id: string;
  persona_id: string | null;
  kind: 'episodic' | 'semantic' | 'procedural';
  content: string;
  valence: number;
  salience: number;
  created_at: number;
  last_accessed_at: number;
  synced_at: number;
}

export async function queryMemories(
  personaId?: string,
  limit?: number,
): Promise<MemoryNodeRow[]> {
  return invoke<MemoryNodeRow[]>('query_memories', {
    personaId: personaId ?? null,
    limit: limit ?? null,
  });
}

export async function upsertMemories(memories: MemoryNodeRow[]): Promise<void> {
  return invoke<void>('upsert_memories', { memories });
}

export async function deleteMemory(id: string): Promise<void> {
  return invoke<void>('delete_memory', { id });
}

export interface OfflineOp {
  id: string;
  operation: string;
  payload: unknown;
  created_at: number;
  retry_count: number;
}

export async function enqueueOfflineOp(operation: string, payload: unknown): Promise<string> {
  return invoke<string>('enqueue_offline_op', { operation, payload });
}

export async function flushOfflineQueue(maxBatchSize?: number): Promise<OfflineOp[]> {
  return invoke<OfflineOp[]>('flush_offline_queue', {
    maxBatchSize: maxBatchSize ?? null,
  });
}

/* ── P3.4: CRDT field-state inspection (GA Sprint 3 Step 12) ──────
 *
 * 这些桥接对应 src-tauri/src/commands/crdt.rs 中的 #[tauri::command]：
 *   - crdt_get_persona_state  → 读 Yjs doc 的字段快照
 *   - crdt_export_full_state  → 导出完整 state vector（用于新设备同步）
 * 写路径 (crdt_apply_local_field_update / _remote_update) 由 sync 引擎
 * 调用，不直接暴露给页面。
 */

export interface PersonaCrdtState {
  persona_id: string;
  /* 字段值是 serde_json::Value，前端按 unknown 处理后再决定如何渲染。 */
  fields: Record<string, unknown>;
}

export async function crdtGetPersonaState(personaId: string): Promise<PersonaCrdtState> {
  return invoke<PersonaCrdtState>('crdt_get_persona_state', { personaId });
}

export interface CrdtUpdatePayload {
  persona_id: string;
  /** Base64-encoded Yrs v1 binary update. */
  update_b64: string;
}

export async function crdtExportFullState(personaId: string): Promise<CrdtUpdatePayload> {
  return invoke<CrdtUpdatePayload>('crdt_export_full_state', { personaId });
}

/* ── T0-B: AI 安全 / 漂移监测 ─────────────────────────────────── */

/**
 * 判断一个 Tauri invoke 的 reject 是否为「命令未注册/未实现」。
 *
 * Tauri 的 invoke 失败既可能 reject 一个 Error，也可能 reject 一个**字符串**（后端返回的错误串），
 * 所以必须对 `String(err)` 做正则，而不能只判 `err instanceof Error`——否则未接的命令会把错误
 * 冒泡成页面错误态，而不是优雅降级（空态）。
 */
function isMissingCommandError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not.*(implemented|registered|found)/i.test(msg);
}

export type DriftAlertLevel = 'ok' | 'warning' | 'critical';

export interface DriftValueDelta {
  valueId: string;
  label: string;
  baseline: number;
  current: number;
  delta: number;
  alertLevel: DriftAlertLevel;
}

export interface DriftReport {
  reportId: string;
  tenantId: string;
  baselineSnapshotId: string | null;
  analyzedAt: number;
  valueDrifts: DriftValueDelta[];
  overallDriftScore: number;
  alertLevel: DriftAlertLevel;
}

/**
 * Fetch the latest drift report. Returns null when the Rust handler is
 * not yet wired (PoC parity with chrono-synth-web's API).
 *
 * Expected Rust command (to be implemented in src-tauri):
 *   #[tauri::command]
 *   async fn get_latest_drift_report() -> Result<Option<DriftReport>, String>
 */
export async function getLatestDriftReport(): Promise<DriftReport | null> {
  try {
    return await invoke<DriftReport | null>('get_latest_drift_report');
  } catch (err) {
    /* 命令未接时优雅降级为 null（与页面空态一致）；Tauri 可能 reject 字符串，故走统一判定。 */
    if (isMissingCommandError(err)) return null;
    throw err;
  }
}

export async function generateDriftReport(): Promise<DriftReport | null> {
  try {
    return await invoke<DriftReport>('generate_drift_report');
  } catch (err) {
    if (isMissingCommandError(err)) return null;
    throw err;
  }
}

/**
 * 本地快照数量——companion 成长视图判断是否有「可对比的历史基线」用（≥2 才算）。
 * 与服务端 countTenantSnapshots 同义：desktop 是单租户本地库，直接数 snapshots 表行数。
 *
 * Rust 端命令（待实现）：
 *   #[tauri::command]
 *   async fn count_snapshots() -> Result<u32, String>
 * 未接时优雅返回 0（= 无基线 → 成长视图走「还在认识你」空态），与 getLatestDriftReport 一致。
 */
export async function queryTenantSnapshotCount(): Promise<number> {
  try {
    return await invoke<number>('count_snapshots');
  } catch (err) {
    /* 未接时优雅返回 0（= 无基线 → 成长视图走「还在认识你」空态）。Tauri 字符串 reject 也覆盖。 */
    if (isMissingCommandError(err)) return 0;
    throw err;
  }
}

/* ---------------------------------------------------------------------- *
 * App settings (kv) — backed by the app_settings table from v007.
 * First user is the first-launch onboarding completion flag; future
 * settings (theme override, telemetry opt-out) reuse the same shape.
 * ---------------------------------------------------------------------- */

/** Read a setting; returns null when the key doesn't exist. */
export async function getAppSetting(key: string): Promise<string | null> {
  return await invoke<string | null>('get_app_setting', { key });
}

/** Upsert a setting. Both arguments are caller-controlled. */
export async function setAppSetting(key: string, value: string): Promise<void> {
  await invoke('set_app_setting', { key, value });
}

/** Convention: namespace + boolean-ish value ('1' = true) for flags. */
export const APP_SETTING_FIRST_RUN_COMPLETED = 'onboarding.first_run_completed';

export async function getFirstRunCompleted(): Promise<boolean> {
  const v = await getAppSetting(APP_SETTING_FIRST_RUN_COMPLETED);
  return v === '1';
}

export async function markFirstRunCompleted(): Promise<void> {
  await setAppSetting(APP_SETTING_FIRST_RUN_COMPLETED, '1');
}
