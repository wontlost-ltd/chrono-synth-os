/**
 * 桌面本地安装包 sidecar 入口（ADR-0061 S1）。
 *
 * 与 src/main.ts 同装配（同一 ChronoSynthOS + createApp），但**单机 profile**：
 *   - 绑 127.0.0.1（红线 2：loopback only，绝不对外）+ 端口 0（内核动态分配，避冲突）；
 *   - 读回**实际绑定端口** + 向 stdout 打**机器可读就绪标记** `CHRONO_SIDECAR_READY {json}`，供 Tauri Rust 父进程解析
 *     （拿端口连接 + 拿 instanceNonce 防端口劫持/误连旧进程，红线 11）；
 *   - SQLite 落 CHRONO_DB_PATH（由 Rust 传 app-data-dir 路径，红线 3）；queue 进程内、Redis/PG/OTEL 关（默认已关）；
 *   - SIGTERM 优雅关停（红线 4：父进程退出→关 sidecar 不留孤儿）。
 *
 * instanceNonce 是**每次启动**随机生成的实例标识（非鉴权 token——完整握手 token 在 S2/S3 落地）：S1 先让父进程
 * 能可靠拿到「本次这个 sidecar 的端口 + 实例标识」，为 S2 sidecar 生命周期 + 握手接线铺路。
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';

/* 单机 profile 覆盖：显式钉死 loopback + 动态端口（红线 2）——不依赖默认（现状默认 0.0.0.0:3000）。
 * 其余（db.path/queue/redis/otel）走既有 env + 默认；Rust 父进程经 env 传 CHRONO_DB_PATH 等。
 *
 * CORS：Tauri WebView 用自定义 scheme origin（macOS `tauri://localhost`，Windows/Linux `http://tauri.localhost`），
 * dev 用 `http://localhost:1420`。前端 apiFetch 带自定义头 `X-Chrono-Desktop-Session`（红线 11 握手）→ 属
 * **非简单请求** → 浏览器先发 CORS 预检 OPTIONS；sidecar 默认 cors.origin=false 会让预检 404 → 真请求被
 * WebView 拦下 → provision/plan 探测全发不出 → 落错外壳/无法登录（真机实测：OPTIONS /auth/login 404）。
 * 故单机 profile 显式放行这些 WebView origin。credentials=false（用 Bearer token 非 cookie），origin 用
 * 白名单数组（非通配），安全边界仍是握手 token（红线 11：loopback≠鉴权边界）。允许 env CHRONO_CORS_ORIGIN 覆盖。 */
const config = loadConfig({
  server: { host: '127.0.0.1', port: 0 },
  cors: {
    origin: (process.env.CHRONO_CORS_ORIGIN
      ? process.env.CHRONO_CORS_ORIGIN.split(',').map((s) => s.trim())
      : ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420']),
    credentials: false,
  },
});

/* OTEL 单机默认关（config 默认 observability.enabled=false）；仍走两阶段 import 保持与 main.ts 同构。 */
const { initTracing, shutdownTracing } = await import('./observability/tracing.js');
initTracing(config.observability);

const { PinoLogger } = await import('./logging/index.js');
const { createDatabase } = await import('./storage/index.js');
const { ChronoSynthOS } = await import('./chrono-synth-os.js');
const { createApp } = await import('./server/index.js');
const { serverState } = await import('./server/routes/health.js');

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
  proactivity: config.proactivity,
  dynamicGrowthBudgetEnabled: config.companion.dynamicGrowthBudgetEnabled,
  skipMigrations: true,
});

/** 本次 sidecar 实例标识（每启动随机；父进程校验防误连旧进程/端口劫持，红线 11 铺路）。 */
const instanceNonce = randomUUID();

async function start(): Promise<void> {
  const app = await createApp({ os, logger, config, db });

  os.start();
  serverState.ready = true;

  /* 绑 127.0.0.1:0 → 内核分配空闲端口。 */
  await app.listen({ host: '127.0.0.1', port: 0 });

  /* 读回**实际**绑定端口（port 0 时必须从 server.address() 拿，config.server.port 仍是 0）。 */
  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : null;
  if (boundPort === null) {
    throw new Error('无法读取 sidecar 实际绑定端口（server.address 非 AddressInfo）');
  }

  logger.info('Sidecar', `本地 sidecar 已启动: http://127.0.0.1:${boundPort}`);
  /* 机器可读就绪标记：Rust 父进程 readline 匹配此前缀，解析 JSON 拿端口 + nonce。单独一行、稳定前缀。 */
  process.stdout.write(`CHRONO_SIDECAR_READY ${JSON.stringify({ host: '127.0.0.1', port: boundPort, instanceNonce })}\n`);

  let isShuttingDown = false;
  function shutdown(signal: string): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Sidecar', `收到 ${signal}，开始优雅关闭...`);
    serverState.shuttingDown = true;
    serverState.ready = false;

    const forceTimeout = setTimeout(() => {
      logger.warn('Sidecar', '优雅关闭超时 (15s)，强制退出');
      process.exit(1);
    }, 15_000);
    forceTimeout.unref();

    app.close().then(async () => {
      try { os.close(); } catch (e) {
        logger.warn('Sidecar', `关闭 OS 时出错: ${e instanceof Error ? e.message : String(e)}`);
      }
      await shutdownTracing();
      clearTimeout(forceTimeout);
      logger.info('Sidecar', '本地 sidecar 已关闭');
      process.exit(0);
    }).catch((err) => {
      logger.error('Sidecar', '关闭时出错', err);
      try { os.close(); } catch { /* 最终兜底 */ }
      process.exit(1);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Sidecar', `未捕获异常: ${err.message}`, err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('Sidecar', `未处理的 Promise 拒绝: ${msg}`, reason);
    shutdown('unhandledRejection');
  });
}

start().catch((err) => {
  logger.error('Sidecar', '启动失败', err);
  console.error('sidecar 启动失败详细:', err instanceof Error ? err.message : err);
  if (err instanceof Error) console.error(err.stack);
  process.exit(1);
});
