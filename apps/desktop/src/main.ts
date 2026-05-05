import type { RuntimeSyncStateV1 } from '@chrono/contracts';
import { ErrorCode, type TenantScope, allValues } from '@chrono/kernel';
import { renderSyncStatusBadge } from './SyncStatusBadge.js';
import { createDesktopEncryption } from './local-encryption.js';
import { bootPersonaRuntime } from './persona-runtime.js';

const initialState: RuntimeSyncStateV1 = 'idle';
const scope: TenantScope = { tenantId: 'desktop-local', actorId: 'desktop-shell' };

console.log('Chrono Desktop initial sync state', {
  state: initialState,
  scope,
  kernelReadyCode: ErrorCode.VALIDATION_REQUIRED,
});

const enc = createDesktopEncryption(btoa('00000000000000000000000000000000'), 'desktop-tenant');
enc.encrypt('hello desktop')
  .then(ct => enc.decrypt(ct))
  .then(pt => console.log('decrypt ok:', pt))
  .catch(err => console.error('decrypt failed:', err));

document.addEventListener('DOMContentLoaded', async () => {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;

  const title = document.createElement('h1');
  title.textContent = 'Chrono Desktop';
  title.style.font = '600 20px system-ui, sans-serif';
  title.style.margin = '0 0 12px';

  const badgeHost = document.createElement('div');
  renderSyncStatusBadge(badgeHost, { state: initialState });

  const runtimeStatus = document.createElement('div');
  runtimeStatus.style.font = '13px system-ui, sans-serif';
  runtimeStatus.style.color = '#666';
  runtimeStatus.style.marginTop = '12px';
  runtimeStatus.textContent = 'Persona runtime: booting…';

  app.append(title, badgeHost, runtimeStatus);

  try {
    const runtime = await bootPersonaRuntime();
    const valueCount = runtime.tx.queryMany(allValues()).length;
    const persistence = runtime.tauriBridgeAvailable ? 'Tauri bridge' : 'in-memory fallback';
    runtimeStatus.textContent = `Persona runtime: ready (${persistence}, ${valueCount} values)`;
  } catch (err) {
    runtimeStatus.style.color = '#b91c1c';
    runtimeStatus.textContent = `Persona runtime: failed — ${err instanceof Error ? err.message : String(err)}`;
  }
});
