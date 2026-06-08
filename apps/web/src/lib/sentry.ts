/**
 * Sentry 初始化
 * 在 React 渲染之前调用，DSN 为空时自动跳过
 */

import * as Sentry from '@sentry/react';
import { APP_ENVIRONMENT, SENTRY_DSN } from '../config';

export function initSentry(): void {
  if (!SENTRY_DSN) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }),
    ],
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    environment: APP_ENVIRONMENT,
    beforeSend(event) {
      if (event.request?.headers) {
        const h = { ...event.request.headers };
        delete h['Authorization'];
        delete h['authorization'];
        delete h['X-API-Key'];
        delete h['x-api-key'];
        delete h['X-Tenant-Id'];
        delete h['x-tenant-id'];
        event.request.headers = h;
      }
      if (event.request?.url) {
        try {
          const u = new URL(event.request.url, globalThis.location?.origin ?? 'http://localhost');
          u.search = '';
          event.request.url = u.toString();
        } catch { /* ignore */ }
      }
      return event;
    },
  });
}

/** 为 API 错误添加 Sentry breadcrumb */
export function addApiBreadcrumb(method: string, path: string, status: number): void {
  Sentry.addBreadcrumb({
    category: 'api',
    message: `${method} ${path}`,
    level: status >= 400 ? 'error' : 'info',
    data: { status },
  });
}
