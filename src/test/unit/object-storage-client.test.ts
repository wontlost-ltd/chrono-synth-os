/**
 * 对象存储客户端单元测试
 * 仅测试 local provider，无需云 SDK
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalObjectStorageClient,
  createObjectStorageClient,
} from '../../privacy/object-storage-client.js';
import { loadConfig } from '../../config/schema.js';

describe('LocalObjectStorageClient', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chrono-ocs-test-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('upload() 将文件写入本地路径', async () => {
    const client = new LocalObjectStorageClient(tmpDir);
    const data = Buffer.from('{"hello":"world"}');
    const key = 'exports/tenant1/job1.pack.json';

    const returnedKey = await client.upload(key, data, 'application/json');
    assert.equal(returnedKey, key, '返回的 key 应与输入 key 相同');

    const written = await readFile(join(tmpDir, key));
    assert.deepEqual(written, data, '写入文件内容应与原始数据一致');
  });

  it('presignUrl() 返回包含 key 的 file:// URL', async () => {
    const client = new LocalObjectStorageClient(tmpDir);
    const key = 'exports/tenant1/job2.pack.json';

    const url = await client.presignUrl(key, 3600);
    assert.ok(url.startsWith('file://'), `URL 应以 file:// 开头，实际: ${url}`);
    assert.ok(url.includes(key), `URL 应包含 key，实际: ${url}`);
  });

  it('upload() 再 presignUrl() 引用同一个文件', async () => {
    const client = new LocalObjectStorageClient(tmpDir);
    const data = Buffer.from('round-trip-test');
    const key = 'exports/tenant2/roundtrip.pack.json';

    await client.upload(key, data, 'application/octet-stream');
    const url = await client.presignUrl(key, 60);

    // 从 file:// URL 提取路径并读取文件
    const filePath = url.replace(/^file:\/\//, '');
    const content = await readFile(filePath);
    assert.deepEqual(content, data, '通过 presignUrl 路径读取的内容应与上传内容一致');
  });

  it('upload() 自动创建多层子目录', async () => {
    const client = new LocalObjectStorageClient(tmpDir);
    const data = Buffer.from('nested-dir-test');
    const key = 'exports/deep/nested/path/file.json';

    await assert.doesNotReject(
      client.upload(key, data, 'application/json'),
      '深层嵌套路径不应抛出错误',
    );
  });

  it('delete() 物理删除已上传对象（GDPR Art.17 闭环）', async () => {
    const client = new LocalObjectStorageClient(tmpDir);
    const key = 'media/tenant1/clip.bin';
    await client.upload(key, Buffer.from('raw-media'), 'application/octet-stream');
    /* 删前存在。 */
    await assert.doesNotReject(readFile(join(tmpDir, key)));
    await client.delete(key);
    /* 删后文件不存在。 */
    await assert.rejects(readFile(join(tmpDir, key)), '删除后原始对象应不存在');
  });

  it('delete() 对不存在的 key 幂等（不抛 not-found）', async () => {
    const client = new LocalObjectStorageClient(tmpDir);
    await assert.doesNotReject(
      client.delete('media/never/existed.bin'),
      '删除不存在对象应视为成功（幂等契约，retention 重试不应反复失败）',
    );
  });
});

describe('createObjectStorageClient', () => {
  it('provider=local 时返回 LocalObjectStorageClient 实例', () => {
    const config = loadConfig({ objectStorage: { provider: 'local', localPath: '/tmp/test' } });
    const client = createObjectStorageClient(config);
    // 验证是 LocalObjectStorageClient（通过构造函数名）
    assert.equal(
      client.constructor.name,
      'LocalObjectStorageClient',
      'createObjectStorageClient 应返回 LocalObjectStorageClient',
    );
  });

  it('未配置 provider 时默认使用 local 后端', () => {
    const config = loadConfig({});
    assert.equal(config.objectStorage.provider, 'local', '默认 provider 应为 local');

    const client = createObjectStorageClient(config);
    assert.equal(client.constructor.name, 'LocalObjectStorageClient');
  });
});
