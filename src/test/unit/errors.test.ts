import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChronoError,
  ValidationError,
  NotFoundError,
  StateError,
  StorageError,
  ConfigError,
  ErrorCode,
} from '../../errors/index.js';

describe('ChronoError', () => {
  it('基础属性正确', () => {
    const err = new ChronoError('测试错误', 500, ErrorCode.STORAGE_READ);
    assert.equal(err.message, '测试错误');
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, 'STORAGE_READ');
    assert.equal(err.name, 'ChronoError');
    assert.ok(err instanceof Error);
  });

  it('toJSON 序列化不含 details', () => {
    const err = new ChronoError('消息', 400, ErrorCode.VALIDATION_RANGE);
    const json = err.toJSON();
    assert.deepEqual(json, {
      error: 'ChronoError',
      code: 'VALIDATION_RANGE',
      message: '消息',
    });
  });

  it('toJSON 序列化含 details', () => {
    const err = new ChronoError('消息', 400, ErrorCode.VALIDATION_RANGE, { field: 'weight' });
    const json = err.toJSON();
    assert.deepEqual(json, {
      error: 'ChronoError',
      code: 'VALIDATION_RANGE',
      message: '消息',
      details: { field: 'weight' },
    });
  });
});

describe('ValidationError', () => {
  it('默认 statusCode 400', () => {
    const err = new ValidationError('无效输入');
    assert.equal(err.statusCode, 400);
    assert.equal(err.name, 'ValidationError');
    assert.ok(err instanceof ChronoError);
    assert.ok(err instanceof Error);
  });

  it('自定义错误码', () => {
    const err = new ValidationError('类型错误', ErrorCode.VALIDATION_TYPE);
    assert.equal(err.code, 'VALIDATION_TYPE');
  });
});

describe('NotFoundError', () => {
  it('默认 statusCode 404', () => {
    const err = new NotFoundError('未找到');
    assert.equal(err.statusCode, 404);
    assert.equal(err.name, 'NotFoundError');
    assert.ok(err instanceof ChronoError);
  });
});

describe('StateError', () => {
  it('默认 statusCode 409', () => {
    const err = new StateError('状态冲突');
    assert.equal(err.statusCode, 409);
    assert.equal(err.name, 'StateError');
    assert.ok(err instanceof ChronoError);
  });
});

describe('StorageError', () => {
  it('默认 statusCode 500', () => {
    const err = new StorageError('存储失败');
    assert.equal(err.statusCode, 500);
    assert.equal(err.name, 'StorageError');
    assert.ok(err instanceof ChronoError);
  });
});

describe('ConfigError', () => {
  it('默认 statusCode 500', () => {
    const err = new ConfigError('配置无效');
    assert.equal(err.statusCode, 500);
    assert.equal(err.name, 'ConfigError');
    assert.ok(err instanceof ChronoError);
  });
});

describe('ErrorCode', () => {
  it('包含所有预期错误码', () => {
    assert.equal(ErrorCode.VALIDATION_RANGE, 'VALIDATION_RANGE');
    assert.equal(ErrorCode.NOT_FOUND_PERSONA, 'NOT_FOUND_PERSONA');
    assert.equal(ErrorCode.STATE_INVALID_TRANSITION, 'STATE_INVALID_TRANSITION');
    assert.equal(ErrorCode.STORAGE_READ, 'STORAGE_READ');
    assert.equal(ErrorCode.CONFIG_INVALID, 'CONFIG_INVALID');
  });
});
