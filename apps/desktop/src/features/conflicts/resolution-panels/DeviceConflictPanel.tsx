/**
 * Device conflict — typical fields:
 *   deviceName, platform, lastSyncAt, syncCursor, registrationStatus
 *
 * Devices conflict when two installs re-register with the same hardware
 * fingerprint (e.g. user restored from a backup onto a second machine).
 * Picking "server" keeps the canonical device record; "local" replaces
 * the server's record with the new install's metadata. Manual-merge is
 * rare here — usually one side is just stale.
 */

import type { ConflictInboxItemV1 } from '@chrono/contracts';
import { ParamComparator } from './shared';

const DEVICE_FIELDS = [
  { id: 'deviceName', label: 'Device name' },
  { id: 'platform', label: 'Platform' },
  { id: 'lastSyncAt', label: 'Last sync' },
  { id: 'syncCursor', label: 'Sync cursor' },
  { id: 'registrationStatus', label: 'Registration' },
];

export function DeviceConflictPanel({ conflict }: { conflict: ConflictInboxItemV1 }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-chrono-text-secondary">
        Device <span className="font-mono">{conflict.entityId}</span> registered
        from two installs. Keep the local record when this install replaces a
        decommissioned device; keep server otherwise.
      </p>
      <ParamComparator fields={DEVICE_FIELDS} conflict={conflict} />
    </div>
  );
}
