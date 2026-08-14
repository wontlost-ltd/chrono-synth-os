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

import type { Logger } from '../../utils/logger.js';
import type { PushProvider } from '../../types/push.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { PushDispatcher, type DeviceLookup, type DeviceLookupResult } from './dispatcher.js';

export interface BuildDispatcherOptions {
  /**
   * 分片 Phase 0 · Plan 1b（Task 3）：共享 `TenantDbResolver`——deviceLookup / onTokenInvalidated
   * 据 tenantId 经 `resolver.dbForTenant(tenantId)` 解析到正确 shard，MobileDeviceService 方法带
   * tenant predicate（选对 shard + 同库跨租户隔离）。取代原按裸 UoW 工厂（无 tenant 上下文）。
   */
  readonly resolver: TenantDbResolver;
  readonly providers: ReadonlyMap<string, PushProvider>;
  readonly logger?: Logger;
}

/**
 * 构造一个把 deviceLookup / onTokenInvalidated 都接好 MobileDeviceService 的
 * PushDispatcher。MobileDeviceService 现持 resolver（Task 3），每次回调传 (tenantId, deviceId)：
 * service 内经 `dbForTenant(tenantId)` 现取该租户 shard 的短事务（不长期持有 transaction，匹配
 * EP-2 "短事务"模式），并按 `WHERE tenant_id=? AND id=?` 隔离。
 */
export function buildPushDispatcher(opts: BuildDispatcherOptions): PushDispatcher {
  const deviceService = new MobileDeviceService(opts.resolver);

  const deviceLookup: DeviceLookup = async (tenantId, deviceId) => {
    const row = deviceService.findById(tenantId, deviceId);
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
    onTokenInvalidated: async (tenantId, deviceId, reason) => {
      deviceService.markTokenInvalid(tenantId, deviceId, reason);
    },
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
