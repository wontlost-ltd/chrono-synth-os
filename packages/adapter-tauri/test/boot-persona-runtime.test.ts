/**
 * adapter-tauri persona-runtime 组合启动测试。
 *
 * 原为 OS 集成测试（boot apps/desktop 骨架的 persona-runtime.ts）；desktop 融合改走本地
 * SQLCipher+HTTP 后，boot 逻辑迁入 @chrono/adapter-tauri 成为正式包 API。此测试保住
 * 「kernel-through-tauri 可启动 + 内存回退 + 经 Tauri 桥持久化并跨启动 rehydrate」的回归。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tpermCmdGrant, tpermQueryByPersonaTool, valueById, upsertValueCmd } from '@chrono/kernel';
import { bootPersonaRuntime } from '../src/boot-persona-runtime.js';

describe('adapter-tauri bootPersonaRuntime', () => {
  it('无 Tauri 桥时回退内存存储并可跑 kernel 调用', async () => {
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    const runtime = await bootPersonaRuntime();
    assert.equal(runtime.tauriBridgeAvailable, false);
    runtime.tx.execute(upsertValueCmd({
      id: 'patience', personaId: 'default', label: 'Patience',
      weight: 0.9, timeDiscount: 0.1, emotionAmplifier: 1.0,
      updatedAt: 1700000000000,
    }));
    const v = runtime.tx.queryOne(valueById('patience'));
    assert.equal(v?.label, 'Patience');
  });

  it('有 mock Tauri 桥时经其持久化，且二次启动能 rehydrate', async () => {
    let savedSnapshot: unknown = null;
    const tauriCalls: string[] = [];
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          tauriCalls.push(cmd);
          if (cmd === 'chrono_kv_load') return savedSnapshot;
          if (cmd === 'chrono_kv_save') { savedSnapshot = args?.['snapshot']; return undefined; }
          if (cmd === 'chrono_kv_clear') { savedSnapshot = null; return undefined; }
          return undefined;
        },
      },
    };
    try {
      const runtime = await bootPersonaRuntime();
      assert.equal(runtime.tauriBridgeAvailable, true);
      runtime.tx.transaction(() => {
        runtime.tx.execute(tpermCmdGrant({
          id: 'tperm_desktop',
          tenantId: 'default', personaId: 'p1', toolId: 'web_search',
          scope: 'execute', constraintsJson: '{}', grantedBy: 'admin',
          now: 1700000000000, expiresAt: null, revocationKey: 'rk_desktop',
        }));
      });
      await runtime.persistence.flushNow();
      assert.ok(savedSnapshot, 'expected the Tauri bridge to receive a snapshot');
      assert.ok(tauriCalls.includes('chrono_kv_load'));
      assert.ok(tauriCalls.includes('chrono_kv_save'));

      /* 二次启动复用同一 Tauri 桥：rehydration 必须看到上面那行 */
      const runtime2 = await bootPersonaRuntime();
      const row = runtime2.tx.queryOne(tpermQueryByPersonaTool({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
      }));
      assert.equal(row?.id, 'tperm_desktop');
    } finally {
      delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    }
  });
});

after(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});
