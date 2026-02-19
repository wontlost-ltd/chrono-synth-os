/**
 * 服务器入口
 * 加载配置 → 初始化追踪 → 创建日志 → 初始化数据库 → 启动 HTTP 服务
 */

import 'dotenv/config';
import { loadConfig } from './config/index.js';

/* OpenTelemetry 必须在其他模块之前初始化 */
const config = loadConfig();

import { initTracing, shutdownTracing } from './observability/tracing.js';
initTracing(config.observability);

import { PinoLogger } from './logging/index.js';
import { createDatabase } from './storage/index.js';
import { ChronoSynthOS } from './chrono-synth-os.js';
import { createApp } from './server/index.js';
import { serverState } from './server/routes/health.js';
const logger = new PinoLogger(config.log.level, config.log.json);
const db = createDatabase(config);
const os = new ChronoSynthOS({
  db,
  logger,
  integrationConfig: {
    minFitness: config.integration.fitnessThreshold,
    minConfidence: config.integration.confidenceThreshold,
  },
  cognitionConfig: config.cognition,
  encryptionConfig: config.encryption,
  skipMigrations: true,
});

async function start(): Promise<void> {
  const app = await createApp({ os, logger, config, db });

  os.start();
  serverState.ready = true;

  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info('Server', `服务已启动: http://${config.server.host}:${config.server.port}`);

  let isShuttingDown = false;
  function shutdown(signal: string): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('Server', `收到 ${signal}，开始优雅关闭...`);
    serverState.shuttingDown = true;
    serverState.ready = false;

    /* 强制退出兜底：防止关闭流程挂起 */
    const forceTimeout = setTimeout(() => {
      logger.warn('Server', '优雅关闭超时 (15s)，强制退出');
      process.exit(1);
    }, 15_000);
    forceTimeout.unref();

    app.close().then(async () => {
      try { os.close(); } catch (e) {
        logger.warn('Server', `关闭 OS 时出错: ${e instanceof Error ? e.message : String(e)}`);
      }
      await shutdownTracing();
      clearTimeout(forceTimeout);
      logger.info('Server', '服务已关闭');
      process.exit(0);
    }).catch((err) => {
      logger.error('Server', '关闭时出错', err);
      try { os.close(); } catch { /* 最终兜底 */ }
      process.exit(1);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Server', `未捕获异常: ${err.message}`, err);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('Server', `未处理的 Promise 拒绝: ${msg}`, reason);
    shutdown('unhandledRejection');
  });
}

start().catch((err) => {
  logger.error('Server', '启动失败', err);
  console.error('启动失败详细:', err instanceof Error ? err.message : err);
  if (err instanceof Error) console.error(err.stack);
  process.exit(1);
});
