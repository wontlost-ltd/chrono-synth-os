/**
 * usePushSync 设备注册回归（ADR-0054 P6）。
 *
 * 锁定接线契约（修复「打错端点」bug）：已登录 + 权限 granted 时，token 注册必须 POST 到真实的
 * `/api/v1/devices`（RegisterDeviceSchema：deviceUid/platform/pushToken），而非已不存在的
 * `/api/v2/devices/push-token`；未登录时**不**注册（带 JWT 才有意义，否则 401）。
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { usePushSync } from './usePushSync';
import * as client from '../api/client';

/* expo-notifications：权限默认 granted，给固定 token；监听器返回可移除句柄。 */
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExpoPushToken[xyz]', type: 'expo' })),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

/* expo-secure-store：首次无 deviceUid → set 后返回（getOrCreateDeviceUid 的持久化路径）。 */
jest.mock('expo-secure-store', () => {
  let stored: string | null = null;
  return {
    getItemAsync: jest.fn(async () => stored),
    setItemAsync: jest.fn(async (_k: string, v: string) => { stored = v; }),
    deleteItemAsync: jest.fn(async () => { stored = null; }),
  };
});

/* Platform.OS 在 jest-expo 默认 'ios'；devicePlatform() 应映射为 'ios'。 */

describe('usePushSync 设备注册', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(client, 'apiFetch').mockResolvedValue(undefined as never);
  });
  afterEach(() => spy.mockRestore());

  it('已登录 + 权限 granted → POST /api/v1/devices，带 deviceUid/platform/pushToken', async () => {
    renderHook(() => usePushSync(jest.fn(), true));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [path, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/devices');           // 真实端点（非 /api/v2/devices/push-token）
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { deviceUid: string; platform: string; pushToken: string };
    expect(body.pushToken).toBe('ExpoPushToken[xyz]');
    expect(['ios', 'android', 'web']).toContain(body.platform); // 合法枚举（非 'expo'）
    expect(typeof body.deviceUid).toBe('string');
    expect(body.deviceUid.length).toBeGreaterThan(0);
  });

  it('未登录 → 不注册（不调 apiFetch）', async () => {
    renderHook(() => usePushSync(jest.fn(), false));
    /* 给微任务一拍，确认确实没有发起注册。 */
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).not.toHaveBeenCalled();
  });
});
