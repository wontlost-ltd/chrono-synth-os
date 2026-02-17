import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, AppConfigSchema } from '../../config/index.js';

describe('配置系统', () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    Object.keys(savedEnv).forEach(k => delete savedEnv[k]);
  });

  it('无参数加载返回默认配置', () => {
    const config = loadConfig();
    assert.equal(config.db.path, ':memory:');
    assert.equal(config.log.level, 'info');
    assert.equal(config.log.json, false);
    assert.equal(config.server.host, '0.0.0.0');
    assert.equal(config.server.port, 3000);
    assert.equal(config.integration.fitnessThreshold, 0.6);
    assert.equal(config.integration.confidenceThreshold, 0.5);
  });

  it('overrides 覆盖默认值', () => {
    const config = loadConfig({ db: { path: './test.db' }, server: { host: '127.0.0.1', port: 8080 } });
    assert.equal(config.db.path, './test.db');
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.port, 8080);
  });

  it('环境变量覆盖默认值', () => {
    setEnv('CHRONO_DB_PATH', '/tmp/env.db');
    setEnv('CHRONO_SERVER_PORT', '9090');
    setEnv('CHRONO_LOG_JSON', 'true');

    const config = loadConfig();
    assert.equal(config.db.path, '/tmp/env.db');
    assert.equal(config.server.port, 9090);
    assert.equal(config.log.json, true);
  });

  it('overrides 优先于环境变量', () => {
    setEnv('CHRONO_SERVER_PORT', '9090');

    const config = loadConfig({ server: { host: '0.0.0.0', port: 7070 } });
    assert.equal(config.server.port, 7070);
  });

  it('Zod 校验拒绝无效端口', () => {
    assert.throws(
      () => loadConfig({ server: { host: '0.0.0.0', port: 99999 } }),
    );
  });

  it('Zod 校验拒绝无效日志级别', () => {
    assert.throws(
      () => AppConfigSchema.parse({ log: { level: 'verbose' } }),
    );
  });

  it('不存在的配置文件不报错', () => {
    const config = loadConfig(undefined, '/nonexistent/config.json');
    assert.equal(config.db.path, ':memory:');
  });
});
