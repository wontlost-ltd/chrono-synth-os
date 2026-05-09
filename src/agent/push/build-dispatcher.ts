/**
 * Pre-wired PushDispatcher factory.
 *
 * Composes the pieces declared in this directory into a runtime-ready
 * dispatcher: deviceLookup reads from MobileDeviceService.findById and
 * onTokenInvalidated calls MobileDeviceService.markTokenInvalid.
 *
 * Callers that don't have a MobileDeviceService at hand (e.g. unit tests)
 * can keep constructing PushDispatcher directly — this factory is just
 * the production-composition convenience.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { Logger } from '../../utils/logger.js';
import type { PushProvider } from '../../types/push.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { PushDispatcher, type DeviceLookup, type DeviceLookupResult } from './dispatcher.js';

export interface BuildDispatcherOptions {
  /** UoW used to construct a fresh MobileDeviceService per lookup. */
  readonly uowFactory: () => SyncWriteUnitOfWork;
  readonly providers: ReadonlyMap<string, PushProvider>;
  readonly logger?: Logger;
}

/**
 * 构造一个把 deviceLookup / onTokenInvalidated 都接好 MobileDeviceService 的
 * PushDispatcher。每次回调里都开一个新的 UoW（factory 调用），避免在 dispatcher
 * 内长期持有一个 transaction，匹配 EP-2 既有的"短事务"模式。
 */
export function buildPushDispatcher(opts: BuildDispatcherOptions): PushDispatcher {
  const deviceLookup: DeviceLookup = async (deviceId) => {
    const tx = opts.uowFactory();
    const svc = new MobileDeviceService(tx);
    const row = svc.findById(deviceId);
    if (!row) return null;
    const result: DeviceLookupResult = {
      platform: row.platform,
      pushToken: row.push_token,
      ...(row.is_invalid_at != null ? { tokenInvalid: true } : {}),
    };
    return result;
  };

  return new PushDispatcher({
    providers: opts.providers,
    deviceLookup,
    onTokenInvalidated: async (deviceId, reason) => {
      const tx = opts.uowFactory();
      const svc = new MobileDeviceService(tx);
      svc.markTokenInvalid(deviceId, reason);
    },
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
