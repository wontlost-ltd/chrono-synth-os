import 'dotenv/config';
import { loadConfig } from './config/index.js';

const config = loadConfig({
  observability: {
    worker: {
      enabled: true,
    },
  },
});

const { initTracing, shutdownTracing } = await import('./observability/tracing.js');
initTracing(config.observability);

const { PinoLogger } = await import('./logging/index.js');
const { createDatabase } = await import('./storage/index.js');
const { ObservabilityPipelineService } = await import('./observability/observability-pipeline-service.js');
const { ObservabilityWorkerMonitorServer } = await import('./observability/observability-worker-monitor.js');

const logger = new PinoLogger(config.log.level, config.log.json);
const db = createDatabase(config);
const pipeline = new ObservabilityPipelineService(db, logger, config.observability);
const monitor = new ObservabilityWorkerMonitorServer({
  db,
  pipeline,
  logger,
}, {
  enabled: config.observability.worker.http.enabled,
  host: config.observability.worker.http.host,
  port: config.observability.worker.http.port,
});

async function start(): Promise<void> {
  await pipeline.start();
  await monitor.start();
  logger.info('ObservabilityWorker', `可观测性 worker 已启动（mode=${pipeline.activeMode}）`);

  let isShuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('ObservabilityWorker', `收到 ${signal}，开始关闭...`);
    try {
      monitor.markShuttingDown();
      await pipeline.stop();
      await monitor.stop();
      db.close();
      await shutdownTracing();
      logger.info('ObservabilityWorker', '可观测性 worker 已关闭');
      process.exit(0);
    } catch (err) {
      logger.error('ObservabilityWorker', '关闭失败', err);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('uncaughtException', (err) => {
    logger.error('ObservabilityWorker', `未捕获异常: ${err.message}`, err);
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('ObservabilityWorker', `未处理的 Promise 拒绝: ${msg}`, reason);
    void shutdown('unhandledRejection');
  });
}

start().catch((err) => {
  logger.error('ObservabilityWorker', '启动失败', err);
  process.exit(1);
});
