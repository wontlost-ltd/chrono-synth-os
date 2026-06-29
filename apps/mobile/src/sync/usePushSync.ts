import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Notification } from 'expo-notifications';
import { apiFetch } from '../api/client';
import { getOrCreateDeviceUid } from './deviceIdentity';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** RegisterDeviceSchema.platform 枚举只认 ios/android/web；RN 的 Platform.OS 映射过去。 */
function devicePlatform(): 'ios' | 'android' | 'web' {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android';
}

/**
 * 注册本设备的推送 token 到后端（ADR-0054 P6）。
 *
 * 走真实的 `POST /api/v1/devices`（RegisterDeviceSchema）——它按 (tenant,user,deviceUid) **upsert**
 * 并在同一调用里落 pushToken，无需单独 PATCH。旧实现打的 `/api/v2/devices/push-token` 后端不存在
 * （注册必失败且被静默吞），本修复对齐后端契约：deviceUid 取持久化稳定 id，platform 取 Platform.OS。
 */
async function registerPushToken(): Promise<void> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  const finalStatus =
    existing === 'granted'
      ? existing
      : (await Notifications.requestPermissionsAsync()).status;

  if (finalStatus !== 'granted') return;

  const token = await Notifications.getExpoPushTokenAsync();
  const deviceUid = await getOrCreateDeviceUid();
  await apiFetch('/api/v1/devices', {
    method: 'POST',
    body: JSON.stringify({ deviceUid, platform: devicePlatform(), pushToken: token.data }),
  });
}

/**
 * @param onSyncTriggered 前台收到 sync/conflict 推送时触发同步。
 * @param authed 是否已登录——token 注册需带 JWT 打 /api/v1/devices，未登录调必 401。
 *   未登录时只挂前台监听、不注册；登录后（authed 变 true）再注册（effect 依赖 authed 重跑）。
 */
export function usePushSync(onSyncTriggered: () => void, authed: boolean): void {
  const onSyncRef = useRef(onSyncTriggered);
  onSyncRef.current = onSyncTriggered;

  useEffect(() => {
    /* 仅在已登录时注册（带 JWT）——未登录注册必 401，且换账号后须用新身份重注册（authed 入依赖）。
     * 注册是 best-effort（失败不阻断；轮询同步照常），但**不再静默吞**——打 console.warn，
     * 避免「打错端点」这类接线 bug 再次无人察觉。 */
    if (authed) {
      void registerPushToken().catch((err: unknown) => {
        console.warn('[usePushSync] 推送 token 注册失败（best-effort，不影响轮询同步）:', err);
      });
    }

    // Foreground push notification triggers immediate sync
    const subscription = Notifications.addNotificationReceivedListener((notification: Notification) => {
      const trigger = notification.request.content.data?.trigger as string | undefined;
      if (trigger === 'sync' || trigger === 'conflict') {
        onSyncRef.current();
      }
    });

    return () => subscription.remove();
  }, [authed]);
}
