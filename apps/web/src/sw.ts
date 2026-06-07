/**
 * Service Worker — PWA 离线支持 + RuntimeSyncStateV2 联动
 *
 * 缓存策略：
 * - app shell：Workbox precache（构建时注入 manifest）
 * - 只读 API（personas/memories/tags）：StaleWhileRevalidate，离线时提供 24h 缓存副本
 * - 其他 API GET：NetworkFirst，5min 缓存
 * - 认证/计费：NetworkOnly（永不缓存）
 * - 静态资源（JS/CSS/图片）：CacheFirst，30d TTL
 *
 * 离线降级：
 * - 只读 API 请求在网络失败时返回缓存快照（offline_readonly 模式下可浏览本地副本）
 * - 写请求（非 GET）在离线时返回 503 + offline 标头，由主线程交由 outbox 处理
 *
 * 主线程通信：
 * - BroadcastChannel 'chrono-sync-state' 广播网络状态切换
 * - 上线：{ type: 'NETWORK_RESTORED' }
 * - 下线：{ type: 'NETWORK_LOST' }
 */

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { BroadcastUpdatePlugin } from 'workbox-broadcast-update';

declare let self: ServiceWorkerGlobalScope;

// ── Precache app shell ────────────────────────────────────────────────────────

precacheAndRoute(self.__WB_MANIFEST);

// ── BroadcastChannel for sync state notifications ────────────────────────────

const syncStateChannel = new BroadcastChannel('chrono-sync-state');

function broadcastNetworkStatus(online: boolean): void {
  syncStateChannel.postMessage(online ? { type: 'NETWORK_RESTORED' } : { type: 'NETWORK_LOST' });
}

// Use global addEventListener (available in SW scope) to avoid DOM-lib type mismatch.
// The DOM lib's ServiceWorkerGlobalScope interface lacks addEventListener/skipWaiting;
// at runtime these are always present in any SW execution context.
const swScope = self as unknown as {
  addEventListener(type: string, listener: (event: Event) => void): void;
  skipWaiting(): Promise<void>;
};

swScope.addEventListener('online', () => broadcastNetworkStatus(true));
swScope.addEventListener('offline', () => broadcastNetworkStatus(false));

// ── Skip waiting on message from main thread ──────────────────────────────────

swScope.addEventListener('message', (event) => {
  const data = (event as MessageEvent<{ type?: string } | null>).data;
  if (data?.type === 'SKIP_WAITING') {
    void swScope.skipWaiting();
  }
});

// ── Cache names ───────────────────────────────────────────────────────────────

const READONLY_API_CACHE = 'api-readonly-cache';
const API_CACHE = 'api-cache';
const STATIC_CACHE = 'static-cache';

// ── Read-only API paths (long-lived, served offline) ─────────────────────────

// These endpoints are safe to serve stale for offline_readonly browsing.
const READONLY_API_PATTERNS = [
  '/api/v1/personas',
  '/api/v1/memories',
  '/api/v1/tags',
  '/api/v1/timeline',
  '/api/v1/insights',
];

function isReadonlyApiPath(pathname: string): boolean {
  return READONLY_API_PATTERNS.some((p) => pathname.startsWith(p));
}

// ── Auth/billing: never cache ─────────────────────────────────────────────────

registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/api/v1/auth') ||
    url.pathname.startsWith('/api/v1/billing'),
  new NetworkOnly(),
);

// ── Read-only API: StaleWhileRevalidate (24h, offline browsing support) ───────

registerRoute(
  ({ url, request }) => request.method === 'GET' && isReadonlyApiPath(url.pathname),
  new StaleWhileRevalidate({
    cacheName: READONLY_API_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 24 * 60 * 60,
      }),
      new BroadcastUpdatePlugin(),
    ],
  }),
);

// ── Other API GET: NetworkFirst (5min fallback) ───────────────────────────────

registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    url.pathname.startsWith('/api/') &&
    !isReadonlyApiPath(url.pathname),
  new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 10,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 5 * 60 }),
    ],
  }),
);

// ── Offline fallback for write API calls ──────────────────────────────────────
// Non-GET API requests that fail while offline get a structured 503 so the main
// thread can route them to the outbox instead of showing a generic network error.

registerRoute(
  ({ url, request }) => url.pathname.startsWith('/api/') && request.method !== 'GET',
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      return new Response(
        JSON.stringify({ error: 'offline', message: 'Request queued for sync' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'X-Chrono-Offline': '1',
          },
        },
      );
    }
  },
);

// ── Static assets: CacheFirst (30d) ──────────────────────────────────────────

registerRoute(
  ({ request }) =>
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font',
  new CacheFirst({
    cacheName: STATIC_CACHE,
    plugins: [
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);
