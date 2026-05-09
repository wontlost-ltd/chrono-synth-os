/**
 * 推送框架统一出口（EP-3.x）.
 *
 * 调用方应 import from '../agent/push/index.js'，避免直接依赖具体的
 * provider / transport 实现。
 */

export { ApnsProvider } from './apns-provider.js';
export type { ApnsConfig, ApnsRequest, ApnsResponse, ApnsTransport } from './apns-provider.js';

export { FcmProvider } from './fcm-provider.js';
export type { FcmConfig, FcmRequest, FcmResponse, FcmTransport } from './fcm-provider.js';

export { MockProvider } from './mock-provider.js';
export type { MockProviderOptions, MockProviderRecord } from './mock-provider.js';

export { PushDispatcher } from './dispatcher.js';
export type {
  DeviceLookup,
  DeviceLookupResult,
  PushDispatcherOptions,
} from './dispatcher.js';

export { buildPushDispatcher } from './build-dispatcher.js';
export type { BuildDispatcherOptions } from './build-dispatcher.js';
