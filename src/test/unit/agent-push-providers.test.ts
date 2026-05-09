/**
 * Unit tests for the EP-3 push framework providers.
 *
 * Each provider is tested in isolation: ApnsProvider/FcmProvider get a
 * stub Transport; MockProvider has no transport. Dispatcher tests cover
 * routing + tokenInvalidated callback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApnsProvider,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
  FcmProvider,
  type FcmRequest,
  type FcmResponse,
  type FcmTransport,
  MockProvider,
  PushDispatcher,
  type DeviceLookupResult,
} from '../../agent/push/index.js';
import type { PushPayload, PushProvider } from '../../types/push.js';

const PAYLOAD: PushPayload = { title: 't', body: 'b' };

/* ── ApnsProvider ────────────────────────────────────────────────────── */

class StubApnsTransport implements ApnsTransport {
  public seen: ApnsRequest[] = [];
  public closed = false;
  constructor(private readonly response: ApnsResponse | Error) {}
  async push(req: ApnsRequest): Promise<ApnsResponse> {
    this.seen.push(req);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('ApnsProvider', () => {
  it('200 response → success result', async () => {
    const transport = new StubApnsTransport({ status: 200, body: null });
    const provider = new ApnsProvider(transport, { bundleId: 'com.example', production: false });
    const result = await provider.send('TOKEN_HEX', PAYLOAD);
    assert.equal(result.success, true);
    assert.equal(transport.seen.length, 1);
    assert.equal(transport.seen[0]!.path, '/3/device/TOKEN_HEX');
    assert.equal(transport.seen[0]!.headers['apns-topic'], 'com.example');
    assert.equal(transport.seen[0]!.headers['apns-priority'], '10');
  });

  it('410 BadDeviceToken → tokenInvalidated', async () => {
    const transport = new StubApnsTransport({
      status: 410,
      body: '{"reason":"BadDeviceToken"}',
    });
    const provider = new ApnsProvider(transport, { bundleId: 'com.example', production: true });
    const result = await provider.send('TOKEN_HEX', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(result.tokenInvalidated, true);
    assert.match(result.error ?? '', /BadDeviceToken/);
  });

  it('400 PayloadTooLarge → not tokenInvalidated', async () => {
    const transport = new StubApnsTransport({
      status: 400,
      body: '{"reason":"PayloadTooLarge"}',
    });
    const provider = new ApnsProvider(transport, { bundleId: 'com.example', production: true });
    const result = await provider.send('TOKEN_HEX', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(result.tokenInvalidated, undefined);
  });

  it('opts.priority normal → header 5; ttlSeconds 0 → expiration 0; collapseKey → header', async () => {
    const transport = new StubApnsTransport({ status: 200, body: null });
    const provider = new ApnsProvider(transport, { bundleId: 'com.example', production: false });
    await provider.send('TOKEN_HEX', PAYLOAD, {
      priority: 'normal',
      ttlSeconds: 0,
      collapseKey: 'msg-7',
    });
    const headers = transport.seen[0]!.headers;
    assert.equal(headers['apns-priority'], '5');
    assert.equal(headers['apns-expiration'], '0');
    assert.equal(headers['apns-collapse-id'], 'msg-7');
  });

  it('transport throws → error result', async () => {
    const transport = new StubApnsTransport(new Error('connection reset'));
    const provider = new ApnsProvider(transport, { bundleId: 'com.example', production: false });
    const result = await provider.send('TOKEN', PAYLOAD);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /connection reset/);
  });

  it('close() forwards to transport', async () => {
    const transport = new StubApnsTransport({ status: 200, body: null });
    const provider = new ApnsProvider(transport, { bundleId: 'com.example', production: false });
    await provider.close();
    assert.equal(transport.closed, true);
  });
});

/* ── FcmProvider ─────────────────────────────────────────────────────── */

class StubFcmTransport implements FcmTransport {
  public seen: FcmRequest[] = [];
  public closed = false;
  constructor(private readonly response: FcmResponse | Error) {}
  async send(req: FcmRequest): Promise<FcmResponse> {
    this.seen.push(req);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('FcmProvider', () => {
  it('200 response → success result', async () => {
    const transport = new StubFcmTransport({ status: 200, body: { name: 'projects/p/messages/123' } });
    const provider = new FcmProvider(transport, { projectId: 'p' });
    const result = await provider.send('FCM_TOKEN', PAYLOAD);
    assert.equal(result.success, true);
  });

  it('UNREGISTERED → tokenInvalidated', async () => {
    const transport = new StubFcmTransport({
      status: 404,
      body: { error: { status: 'NOT_FOUND' } },
    });
    const provider = new FcmProvider(transport, { projectId: 'p' });
    const result = await provider.send('FCM_TOKEN', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(result.tokenInvalidated, true);
    assert.match(result.error ?? '', /UNREGISTERED/);
  });

  it('error.details[].errorCode INVALID_ARGUMENT → tokenInvalidated', async () => {
    const transport = new StubFcmTransport({
      status: 400,
      body: { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } },
    });
    const provider = new FcmProvider(transport, { projectId: 'p' });
    const result = await provider.send('FCM_TOKEN', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(result.tokenInvalidated, true);
  });

  it('500 internal → not tokenInvalidated (retry-able)', async () => {
    const transport = new StubFcmTransport({
      status: 500,
      body: { error: { status: 'INTERNAL' } },
    });
    const provider = new FcmProvider(transport, { projectId: 'p' });
    const result = await provider.send('FCM_TOKEN', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(result.tokenInvalidated, undefined);
  });

  it('opts.ttlSeconds and collapseKey embedded in android block', async () => {
    const transport = new StubFcmTransport({ status: 200, body: { name: 'm' } });
    const provider = new FcmProvider(transport, { projectId: 'p' });
    await provider.send('FCM_TOKEN', PAYLOAD, {
      priority: 'high',
      ttlSeconds: 3600,
      collapseKey: 'msg-7',
    });
    const message = (transport.seen[0]!.body as { message: Record<string, unknown> }).message;
    const android = message['android'] as Record<string, unknown>;
    assert.equal(android['priority'], 'HIGH');
    assert.equal(android['ttl'], '3600s');
    assert.equal(android['collapse_key'], 'msg-7');
  });
});

/* ── PushDispatcher ──────────────────────────────────────────────────── */

describe('PushDispatcher', () => {
  function makeDispatcher(devices: Map<string, DeviceLookupResult | null>) {
    const apns = new MockProvider({ channel: 'apns' });
    const fcm = new MockProvider({ channel: 'fcm' });
    const invalidations: Array<{ deviceId: string; reason: string }> = [];
    const dispatcher = new PushDispatcher({
      providers: new Map<string, PushProvider>([['apns', apns], ['fcm', fcm]]),
      deviceLookup: async (id) => devices.get(id) ?? null,
      onTokenInvalidated: async (deviceId, reason) => {
        invalidations.push({ deviceId, reason });
      },
    });
    return { dispatcher, apns, fcm, invalidations };
  }

  it('routes ios platform to apns provider', async () => {
    const { dispatcher, apns } = makeDispatcher(
      new Map([['dev_1', { platform: 'ios', pushToken: 'TOKEN_A' }]]),
    );
    const result = await dispatcher.send('tenant', 'dev_1', PAYLOAD);
    assert.equal(result.success, true);
    assert.equal(apns.sent.length, 1);
    assert.equal(apns.sent[0]!.pushToken, 'TOKEN_A');
  });

  it('routes android platform to fcm provider', async () => {
    const { dispatcher, fcm } = makeDispatcher(
      new Map([['dev_2', { platform: 'android', pushToken: 'TOKEN_B' }]]),
    );
    const result = await dispatcher.send('tenant', 'dev_2', PAYLOAD);
    assert.equal(result.success, true);
    assert.equal(fcm.sent.length, 1);
  });

  it('returns success:false when device unknown', async () => {
    const { dispatcher } = makeDispatcher(new Map());
    const result = await dispatcher.send('tenant', 'missing', PAYLOAD);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /device not found/);
  });

  it('returns success:false when device has no pushToken', async () => {
    const { dispatcher } = makeDispatcher(
      new Map([['dev_3', { platform: 'ios', pushToken: null }]]),
    );
    const result = await dispatcher.send('tenant', 'dev_3', PAYLOAD);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /no push token/);
  });

  it('returns success:false when no provider for platform', async () => {
    const apnsOnly = new MockProvider({ channel: 'apns' });
    const dispatcher = new PushDispatcher({
      providers: new Map<string, PushProvider>([['apns', apnsOnly]]),
      deviceLookup: async () => ({ platform: 'android', pushToken: 'TOKEN' }),
    });
    const result = await dispatcher.send('tenant', 'dev_x', PAYLOAD);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /no provider/);
  });

  it('fires tokenInvalidated callback when provider reports invalid', async () => {
    const apns = new MockProvider({ channel: 'apns', invalidTokens: ['TOKEN_BAD'] });
    const invalidations: Array<{ deviceId: string; reason: string }> = [];
    const dispatcher = new PushDispatcher({
      providers: new Map<string, PushProvider>([['apns', apns]]),
      deviceLookup: async () => ({ platform: 'ios', pushToken: 'TOKEN_BAD' }),
      onTokenInvalidated: async (deviceId, reason) => {
        invalidations.push({ deviceId, reason });
      },
    });
    const result = await dispatcher.send('tenant', 'dev_bad', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(result.tokenInvalidated, true);
    /* fire-and-forget — wait one microtask flush */
    await new Promise((r) => setImmediate(r));
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0]!.deviceId, 'dev_bad');
  });

  it('skips invalidated devices without provider call', async () => {
    const apns = new MockProvider({ channel: 'apns' });
    const dispatcher = new PushDispatcher({
      providers: new Map<string, PushProvider>([['apns', apns]]),
      deviceLookup: async () => ({ platform: 'ios', pushToken: 'TOKEN_OLD', tokenInvalid: true }),
    });
    const result = await dispatcher.send('tenant', 'dev_old', PAYLOAD);
    assert.equal(result.success, false);
    assert.equal(apns.sent.length, 0);
  });

  it('sendBatch processes ids in order, even on partial failure', async () => {
    const apns = new MockProvider({ channel: 'apns', failingTokens: ['TOKEN_2'] });
    const dispatcher = new PushDispatcher({
      providers: new Map<string, PushProvider>([['apns', apns]]),
      deviceLookup: async (id) => ({
        platform: 'ios',
        pushToken: id === 'd1' ? 'TOKEN_1' : id === 'd2' ? 'TOKEN_2' : 'TOKEN_3',
      }),
    });
    const results = await dispatcher.sendBatch('tenant', ['d1', 'd2', 'd3'], PAYLOAD);
    assert.equal(results.length, 3);
    assert.equal(results[0]!.success, true);
    assert.equal(results[1]!.success, false);
    assert.equal(results[2]!.success, true);
    assert.deepEqual(apns.sent.map((r) => r.pushToken), ['TOKEN_1', 'TOKEN_2', 'TOKEN_3']);
  });

  it('close() closes all distinct providers', async () => {
    const apns = new MockProvider({ channel: 'apns' });
    const fcm = new MockProvider({ channel: 'fcm' });
    const dispatcher = new PushDispatcher({
      providers: new Map<string, PushProvider>([['apns', apns], ['fcm', fcm]]),
      deviceLookup: async () => null,
    });
    await dispatcher.close();
    assert.equal(apns.closed.value, true);
    assert.equal(fcm.closed.value, true);
  });
});
