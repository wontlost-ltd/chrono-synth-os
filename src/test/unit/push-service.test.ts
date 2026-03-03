import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockPushService } from '../../server/services/push-service.js';
import type { PushPayload, PushService } from '../../server/services/push-service.js';

describe('MockPushService', () => {
  it('实现 PushService 接口', () => {
    const svc: PushService = new MockPushService();
    assert.equal(svc.channel, 'mock');
    assert.equal(typeof svc.send, 'function');
    assert.equal(typeof svc.sendBatch, 'function');
  });

  it('send 记录推送并返回成功', async () => {
    const svc = new MockPushService();
    const payload: PushPayload = { title: '测试', body: '内容' };
    const result = await svc.send('tenant_1', 'dev_1', payload);
    assert.equal(result.deviceId, 'dev_1');
    assert.equal(result.success, true);
    assert.equal(svc.sent.length, 1);
    assert.deepEqual(svc.sent[0], { tenantId: 'tenant_1', deviceId: 'dev_1', payload });
  });

  it('sendBatch 批量发送并返回结果数组', async () => {
    const svc = new MockPushService();
    const payload: PushPayload = { title: '批量', body: '通知', badge: 3 };
    const results = await svc.sendBatch('t1', ['d1', 'd2', 'd3'], payload);
    assert.equal(results.length, 3);
    assert.equal(results[0].deviceId, 'd1');
    assert.equal(results[1].deviceId, 'd2');
    assert.equal(results[2].deviceId, 'd3');
    for (const r of results) assert.equal(r.success, true);
    assert.equal(svc.sent.length, 3);
    for (const entry of svc.sent) {
      assert.equal(entry.tenantId, 't1');
      assert.deepEqual(entry.payload, payload);
    }
  });

  it('send 支持 data/sound 可选字段', async () => {
    const svc = new MockPushService();
    const payload: PushPayload = {
      title: 'T',
      body: 'B',
      data: { key: 'val' },
      sound: 'default',
    };
    await svc.send('t', 'd', payload);
    assert.equal(svc.sent[0].payload.data?.key, 'val');
    assert.equal(svc.sent[0].payload.sound, 'default');
  });

  it('多次 send 累计记录', async () => {
    const svc = new MockPushService();
    await svc.send('t', 'd1', { title: 'A', body: 'a' });
    await svc.send('t', 'd2', { title: 'B', body: 'b' });
    assert.equal(svc.sent.length, 2);
  });
});
