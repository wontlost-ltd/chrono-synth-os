import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import type { Notification } from 'expo-notifications';
import { apiFetch } from '../api/client';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function registerPushToken(): Promise<void> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  const finalStatus =
    existing === 'granted'
      ? existing
      : (await Notifications.requestPermissionsAsync()).status;

  if (finalStatus !== 'granted') return;

  const token = await Notifications.getExpoPushTokenAsync();
  await apiFetch('/api/v2/devices/push-token', {
    method: 'POST',
    body: JSON.stringify({ token: token.data, platform: 'expo' }),
  });
}

export function usePushSync(onSyncTriggered: () => void): void {
  const onSyncRef = useRef(onSyncTriggered);
  onSyncRef.current = onSyncTriggered;

  useEffect(() => {
    void registerPushToken().catch(() => {
      // Push token registration is best-effort; sync still works via polling
    });

    // Foreground push notification triggers immediate sync
    const subscription = Notifications.addNotificationReceivedListener((notification: Notification) => {
      const trigger = notification.request.content.data?.trigger as string | undefined;
      if (trigger === 'sync' || trigger === 'conflict') {
        onSyncRef.current();
      }
    });

    return () => subscription.remove();
  }, []);
}
