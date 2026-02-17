/**
 * 安全头插件
 * 基于 @fastify/helmet 设置 HTTP 安全响应头
 */

import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
}
