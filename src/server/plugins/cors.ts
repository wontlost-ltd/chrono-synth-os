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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Correlation-Id', 'X-API-Key'],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  });
}
