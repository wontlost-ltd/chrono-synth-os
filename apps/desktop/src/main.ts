import type { RuntimeSyncStateV1 } from '@chrono/contracts';
import { ErrorCode, type TenantScope } from '@chrono/kernel';
import { renderSyncStatusBadge } from './SyncStatusBadge.js';
import { createDesktopEncryption } from './local-encryption.js';

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

document.addEventListener('DOMContentLoaded', () => {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;

  const title = document.createElement('h1');
  title.textContent = 'Chrono Desktop';
  title.style.font = '600 20px system-ui, sans-serif';
  title.style.margin = '0 0 12px';

  const badgeHost = document.createElement('div');
  renderSyncStatusBadge(badgeHost, { state: initialState });

  app.append(title, badgeHost);
});
