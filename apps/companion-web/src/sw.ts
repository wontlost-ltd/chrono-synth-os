/**
 * ChronoCompanion Service Worker — PWA 离线支持（Phase 2.2）。
 *
 * companion 是只读浏览型 C 端（看「我的数字人 / 成长 / 记忆」），无离线写 outbox，
 * 故策略比企业版 apps/web 精简：
 *   - app shell：Workbox precache（构建期注入 manifest）。
 *   - companion 只读 API（/api/v1/companion/me*）：StaleWhileRevalidate，离线时供 24h 缓存副本
 *     →「断网也能看自己的数字人」。
 *   - auth：NetworkOnly（永不缓存令牌/会话）。
 *   - 静态资源（JS/CSS/图片/字体）：CacheFirst，30d。
 *
 * injectManifest 策略（与 apps/web 一致）：本文件是 SW 源码，构建期由 vite-plugin-pwa 注入
 * self.__WB_MANIFEST 后编译为 sw.js。
 */

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare let self: ServiceWorkerGlobalScope;

/* precache app shell（构建期注入）。 */
precacheAndRoute(self.__WB_MANIFEST);

/* SW 作用域里 addEventListener/skipWaiting/clients 运行时恒在，但 DOM lib 类型不全——弱类型访问。 */
/* install/activate 是 ExtendableEvent（运行时必有 waitUntil）；显式类型避免 waitUntil 被
 * optional-chaining 静默跳过（否则 activate 清缓存/claim 可能不执行）。DOM lib 不全，弱声明。 */
type SwExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void };
const swScope = self as unknown as {
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

const COMPANION_API_CACHE = 'companion-api-cache';
const STATIC_CACHE = 'companion-static-cache';

/* injectManifest 策略下，autoUpdate 不会自动给自写 SW 注入 skipWaiting/clientsClaim，
 * 否则新 SW 会卡在 waiting 永不激活——这里显式做：install 即 skipWaiting，activate 即 claim。 */
swScope.addEventListener('install', () => {
  void swScope.skipWaiting();
});
swScope.addEventListener('activate', (event: SwExtendableEvent) => {
  /* 新 SW 激活时清空 companion 私有 API 缓存：旧版 SW 写入的条目可能没有 Vary 头，
   * 按 URL 命中会回显上一账号数据——activate 删除消除这条升级残留路径（Codex Major）。
   * static 缓存是公开/hashed 资源，无需清。 */
  event.waitUntil(
    (async () => {
      await caches.delete(COMPANION_API_CACHE);
      await swScope.clients.claim();
    })(),
  );
});

/* 主线程发 SKIP_WAITING 时也立即激活（双保险）。 */
swScope.addEventListener('message', (event) => {
  const data = (event as MessageEvent<{ type?: string } | null>).data;
  if (data?.type === 'SKIP_WAITING') {
    void swScope.skipWaiting();
  }
});

/* auth：永不缓存。 */
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/v1/auth'),
  new NetworkOnly(),
);

/* companion 只读 API：StaleWhileRevalidate（24h，支持离线浏览自己的数字人）。 */
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' && url.pathname.startsWith('/api/v1/companion/me'),
  new StaleWhileRevalidate({
    cacheName: COMPANION_API_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 }),
    ],
  }),
);

/* 静态资源：CacheFirst（30d）。 */
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
