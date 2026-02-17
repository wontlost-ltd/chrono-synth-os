import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PinoLogger } from '../../logging/index.js';
import type { Logger } from '../../utils/logger.js';

describe('PinoLogger', () => {
  it('实现 Logger 接口四个方法', () => {
    const logger: Logger = new PinoLogger('warn');
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
  });

  it('所有日志方法不抛异常', () => {
    const logger = new PinoLogger('error');
    assert.doesNotThrow(() => logger.debug('test', '调试消息'));
    assert.doesNotThrow(() => logger.info('test', '信息消息'));
    assert.doesNotThrow(() => logger.warn('test', '警告消息'));
    assert.doesNotThrow(() => logger.error('test', '错误消息', { err: 'detail' }));
  });

  it('pino getter 返回底层实例', () => {
    const logger = new PinoLogger('info');
    assert.ok(logger.pino);
    assert.equal(typeof logger.pino.info, 'function');
  });

  it('child 创建子日志器', () => {
    const logger = new PinoLogger('info');
    const child = logger.child({ requestId: 'req-123' });
    assert.ok(child instanceof PinoLogger);
    assert.doesNotThrow(() => child.info('test', '子日志消息'));
  });

  it('child 子日志器保持 Logger 接口兼容', () => {
    const logger = new PinoLogger('info');
    const child: Logger = logger.child({ correlationId: 'abc' });
    assert.equal(typeof child.debug, 'function');
    assert.equal(typeof child.info, 'function');
    assert.equal(typeof child.warn, 'function');
    assert.equal(typeof child.error, 'function');
  });
});
