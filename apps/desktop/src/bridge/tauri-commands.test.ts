import { describe, it, expect, vi, beforeEach } from 'vitest';

/* mock Tauri invoke——重点验证「命令未注册」时的优雅降级。
 * Tauri 的 invoke 失败常 reject 一个**字符串**（而非 Error），这正是 isMissingCommandError
 * 必须用 String(err) 判定的原因（Codex PR-A Major）。 */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  queryTenantSnapshotCount,
  getLatestDriftReport,
  generateDriftReport,
} from './tauri-commands';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
});

describe('优雅降级：命令未注册（Tauri reject 字符串）', () => {
  it('queryTenantSnapshotCount：字符串 reject "command not found" → 返回 0（空态）', async () => {
    invokeMock.mockRejectedValue('command count_snapshots not found');
    await expect(queryTenantSnapshotCount()).resolves.toBe(0);
  });

  it('getLatestDriftReport：字符串 reject "not implemented" → 返回 null', async () => {
    invokeMock.mockRejectedValue('get_latest_drift_report not implemented');
    await expect(getLatestDriftReport()).resolves.toBeNull();
  });

  it('generateDriftReport：字符串 reject "not registered" → 返回 null', async () => {
    invokeMock.mockRejectedValue('generate_drift_report is not registered');
    await expect(generateDriftReport()).resolves.toBeNull();
  });

  it('非「未注册」类错误（如真实 DB 错误）仍抛出，不被吞掉', async () => {
    invokeMock.mockRejectedValue('database disk image is malformed');
    await expect(queryTenantSnapshotCount()).rejects.toBeTruthy();
  });

  it('命令存在时正常返回值', async () => {
    invokeMock.mockResolvedValue(7);
    await expect(queryTenantSnapshotCount()).resolves.toBe(7);
  });
});
