/**
 * CORS 插件
 * 基于 @fastify/cors 配置跨域访问策略
 */

import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from '../../config/schema.js';

export async function registerCors(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    /* X-Chrono-Desktop-Session：桌面单机 sidecar 握手头（红线 11）。前端每请求带它 → 属非简单请求 →
     * 触发 CORS 预检；allowedHeaders 必须含它，否则 WebView 预检拒绝、真请求发不出（登录/provision 全挂）。 */
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Correlation-Id', 'X-API-Key', 'X-Tenant-Id', 'X-CSRF-Protection', 'X-CSRF-Token', 'X-Chrono-Desktop-Session'],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  });
}
