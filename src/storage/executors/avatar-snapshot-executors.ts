/**
 * Avatar 快照 SQL 执行器（只读查询）
 */

import { registerQuery } from '../legacy-sync-bridge.js';
import {
  ASNAP_QUERY_AUTORUN_CONFIG, ASNAP_QUERY_DRIFT_CONFIG,
  ASNAP_QUERY_LAST_RUN_METRICS, ASNAP_QUERY_INSTALLED_DEVICES,
} from '@chrono/kernel';
import type {
  AsnapAutorunRow, AsnapDriftConfigRow, AsnapLastRunRow, AsnapDeviceIdRow,
  AsnapTenantAvatarParams, AsnapLastRunParams,
} from '@chrono/kernel';

export function registerAvatarSnapshotExecutors(): void {
  registerQuery<AsnapAutorunRow | null, AsnapTenantAvatarParams>(ASNAP_QUERY_AUTORUN_CONFIG, (db, p) => {
    return db.prepare<AsnapAutorunRow>(
      'SELECT enabled, interval_ms, last_run_at FROM avatar_autorun_config WHERE tenant_id = ? AND avatar_id = ? LIMIT 1',
    ).get(p.tenantId, p.avatarId) ?? null;
  });

  registerQuery<AsnapDriftConfigRow | null, AsnapTenantAvatarParams>(ASNAP_QUERY_DRIFT_CONFIG, (db, p) => {
    return db.prepare<AsnapDriftConfigRow>(
      'SELECT drift_threshold, last_drift_check_at, review_required FROM avatar_autorun_config WHERE tenant_id = ? AND avatar_id = ? LIMIT 1',
    ).get(p.tenantId, p.avatarId) ?? null;
  });

  registerQuery<AsnapLastRunRow | null, AsnapLastRunParams>(ASNAP_QUERY_LAST_RUN_METRICS, (db, p) => {
    return db.prepare<AsnapLastRunRow>(
      'SELECT metrics_json FROM avatar_autorun_runlog WHERE tenant_id = ? AND avatar_id = ? AND status = ? ORDER BY completed_at DESC LIMIT 1',
    ).get(p.tenantId, p.avatarId, p.status) ?? null;
  });

  registerQuery<readonly AsnapDeviceIdRow[], string>(ASNAP_QUERY_INSTALLED_DEVICES, (db, avatarId) => {
    return db.prepare<AsnapDeviceIdRow>(
      'SELECT device_id FROM device_avatars WHERE avatar_id = ?',
    ).all(avatarId);
  });
}
