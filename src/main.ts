/**
 * 服务器入口
 * 加载配置 → 创建日志 → 初始化数据库 → 启动 HTTP 服务
 */

import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { PinoLogger } from './logging/index.js';
import { createDatabase } from './storage/index.js';
import { ChronoSynthOS } from './chrono-synth-os.js';
import { createApp } from './server/index.js';
import { serverState } from './server/routes/health.js';

const config = loadConfig();
const logger = new PinoLogger(config.log.level, config.log.json);
const db = createDatabase(config);
const os = new ChronoSynthOS({
  db,
  logger,
  integrationConfig: {
    minFitness: config.integration.fitnessThreshold,
    minConfidence: config.integration.confidenceThreshold,
  },
  skipMigrations: true,
});

async function start(): Promise<void> {
  const app = await createApp({ os, logger, config, db });

  os.start();
  serverState.ready = true;

  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info('Server', `服务已启动: http://${config.server.host}:${config.server.port}`);

  function shutdown(signal: string): void {
    logger.info('Server', `收到 ${signal}，开始优雅关闭...`);
    serverState.shuttingDown = true;
    app.close().then(() => {
      os.close();
      logger.info('Server', '服务已关闭');
      process.exit(0);
    }).catch((err) => {
      logger.error('Server', '关闭时出错', err);
      process.exit(1);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('Server', '启动失败', err);
  process.exit(1);
});
