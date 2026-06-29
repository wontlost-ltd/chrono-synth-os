declare module 'expo-background-fetch' {
  export enum BackgroundFetchResult {
    NoData = 1,
    NewData = 2,
    Failed = 3,
  }

  export enum BackgroundFetchStatus {
    Denied = 1,
    Restricted = 2,
    Available = 3,
  }

  export interface BackgroundFetchOptions {
    minimumInterval?: number;
    stopOnTerminate?: boolean;
    startOnBoot?: boolean;
  }

  export function getStatusAsync(): Promise<BackgroundFetchStatus>;
  export function registerTaskAsync(taskName: string, options?: BackgroundFetchOptions): Promise<void>;
  export function unregisterTaskAsync(taskName: string): Promise<void>;
}

declare module 'expo-task-manager' {
  export type TaskManagerTask<T = unknown> = {
    data: T;
    error: Error | null;
    executionInfo: { taskName: string };
  };

  export type TaskExecutorCallback<T = unknown> = (task: TaskManagerTask<T>) => unknown;

  export function defineTask<T = unknown>(taskName: string, callback: TaskExecutorCallback<T>): void;
  export function isTaskRegisteredAsync(taskName: string): Promise<boolean>;
}

declare module 'expo-notifications' {
  export interface PermissionResponse {
    status: 'granted' | 'denied' | 'undetermined';
  }

  export interface ExpoPushToken {
    data: string;
    type: 'expo';
  }

  export interface NotificationContent {
    title: string | null;
    body: string | null;
    data: Record<string, unknown>;
  }

  export interface NotificationRequest {
    identifier: string;
    content: NotificationContent;
    trigger: unknown;
  }

  export interface Notification {
    date: number;
    request: NotificationRequest;
  }

  export interface NotificationSubscription {
    remove(): void;
  }

  export interface NotificationHandlerBehavior {
    shouldShowAlert: boolean;
    shouldPlaySound: boolean;
    shouldSetBadge: boolean;
  }

  export function setNotificationHandler(handler: {
    handleNotification(notification: Notification): Promise<NotificationHandlerBehavior>;
  }): void;

  export function getPermissionsAsync(): Promise<PermissionResponse>;
  export function requestPermissionsAsync(): Promise<PermissionResponse>;
  export function getExpoPushTokenAsync(): Promise<ExpoPushToken>;
  export function addNotificationReceivedListener(
    listener: (notification: Notification) => void,
  ): NotificationSubscription;
}

declare module 'expo-secure-store' {
  export function getItemAsync(key: string): Promise<string | null>;
  export function setItemAsync(key: string, value: string): Promise<void>;
  export function deleteItemAsync(key: string): Promise<void>;
}
