/**
 * Integration test: apps/desktop/src/persona-runtime.ts boots cleanly via the
 * adapter-tauri composition path, with a mock Tauri invoke bridge installed
 * on globalThis.__TAURI__.
 *
 * Loads the desktop runtime through the compiled apps/desktop/dist output
 * so we exercise the same code Vite would ship.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tpermCmdGrant, tpermQueryByPersonaTool, valueById, upsertValueCmd } from '@chrono/kernel';

interface DesktopRuntimeModule {
  bootPersonaRuntime: () => Promise<{
    tx: import('@chrono/adapter-web').WebUnitOfWork;
    persistence: import('@chrono/adapter-web').WebPersistenceController;
    tauriBridgeAvailable: boolean;
  }>;
}

const desktopDist = resolve(process.cwd(), 'apps', 'desktop', 'dist', 'persona-runtime.js');

let mod: DesktopRuntimeModule;

before(async () => {
  if (!existsSync(desktopDist)) {
    /* The desktop tsconfig isn't part of `npm run build`; compile on demand. */
    execSync('npx tsc -b apps/desktop/tsconfig.json', { stdio: 'inherit' });
  }
  mod = await import(pathToFileURL(desktopDist).href);
});

describe('desktop persona-runtime integration', () => {
  it('boots without a Tauri bridge (in-memory fallback)', async () => {
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    const runtime = await mod.bootPersonaRuntime();
    assert.equal(runtime.tauriBridgeAvailable, false);
    /* Sanity: kernel calls work through the runtime */
    runtime.tx.execute(upsertValueCmd({
      id: 'patience', label: 'Patience',
      weight: 0.9, timeDiscount: 0.1, emotionAmplifier: 1.0,
      updatedAt: 1700000000000,
    }));
    const v = runtime.tx.queryOne(valueById('patience'));
    assert.equal(v?.label, 'Patience');
  });

  it('boots with a mock Tauri bridge and persists through it', async () => {
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
      const runtime = await mod.bootPersonaRuntime();
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

      /* Boot a second runtime backed by the same Tauri bridge: rehydration must see the row */
      const runtime2 = await mod.bootPersonaRuntime();
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
