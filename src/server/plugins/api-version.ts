/**
 * API 版本化插件
 * 在所有响应中添加 X-API-Version 头
 * 支持 Deprecation / Sunset 头标记过时端点
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

let _apiVersion: string | undefined;
function getApiVersion(): string {
  if (_apiVersion) return _apiVersion;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, '../../../package.json'), 'utf-8'));
    _apiVersion = pkg.version ?? '0.0.0';
  } catch {
    _apiVersion = '0.0.0';
  }
  return _apiVersion!;
}

export function registerApiVersion(app: FastifyInstance): void {
  app.addHook('onSend', (_request: FastifyRequest, reply: FastifyReply, _payload, done) => {
    reply.header('X-API-Version', getApiVersion());
    done();
  });
}
