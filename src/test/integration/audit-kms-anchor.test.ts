/**
 * P0-E v2 — audit chain KMS anchor service integration tests.
 *
 * 验证：
 *   1. flag 开启时，触发后写入一条 anchor，并指向最新链尾；
 *   2. 同一链尾重复触发幂等，不会重复插入；
 *   3. 篡改 audit 行后，verifier 能识别 chain_broken_before_anchor；
 *   4. flag 关闭时，触发的 skipped 计数 ≥1 且零写入。
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import {
  AuditChainAnchorService,
  type AuditChainKmsProvider,
} from '../../audit/audit-chain-anchor-service.js';
import { verifyAuditAnchors } from '../../audit/audit-anchor-verifier.js';
import { recordRequestAuditLog } from '../../audit/audit-log-store.js';
import { FeatureFlagService } from '../../feature-flags/feature-flag-service.js';
import { resetCoreSelfExecutors } from '../../storage/executors/index.js';
import {
  createMemoryDatabase,
  runDslSqliteMigrations,
  type IDatabase,
} from '../../storage/index.js';
import { TestClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';

const TENANT = 'tenant-anchor';

class TestKmsProvider implements AuditChainKmsProvider {
  private readonly key = Buffer.from('audit-anchor-test-key');
  readonly keyId = 'test-kms-key';
  readonly alg = 'HMAC-SHA256';

  async sign(payload: Buffer): Promise<{ keyId: string; signature: string; alg: string }> {
    return {
      keyId: this.keyId,
      signature: createHmac('sha256', this.key).update(payload).digest('base64'),
      alg: this.alg,
    };
  }

  async verify(payload: Buffer, signature: Buffer, keyId: string, alg: string): Promise<boolean> {
    if (keyId !== this.keyId || alg !== this.alg) return false;
    const expected = createHmac('sha256', this.key).update(payload).digest();
    return expected.equals(signature);
  }
}

interface AnchorCountRow { count: number }
interface AnchorRow { to_seq: number; tail_hash: string; key_id: string }

function seedAuditRows(db: IDatabase, count: number): void {
  for (let i = 0; i < count; i += 1) {
    recordRequestAuditLog(db, {
      tenantId: TENANT,
      requestId: `req-${i}`,
      method: 'GET',
      path: `/api/test/${i}`,
      statusCode: 200,
      latencyMs: i + 1,
      actionType: 'read',
    });
  }
}

function createService(
  db: IDatabase,
  featureFlags: FeatureFlagService,
  kms: AuditChainKmsProvider = new TestKmsProvider(),
): AuditChainAnchorService {
  return new AuditChainAnchorService({
    db,
    kmsProvider: kms,
    featureFlags,
    clock: new TestClock(1_700_000_000_000),
    logger: new SilentLogger(),
  });
}

describe('P0-E v2 — audit chain KMS anchors', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('anchors the latest tail when the feature flag is enabled', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 4);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const service = createService(db, flags);

    const result = await service.triggerOnce();
    assert.equal(result.anchored.length, 1);
    assert.equal(result.anchored[0]?.tenantId, TENANT);
    assert.equal(result.anchored[0]?.toSeq, 4);
    assert.equal(result.skipped, 0);

    const anchor = db.prepare<AnchorRow>(
      `SELECT to_seq, tail_hash, key_id FROM audit_chain_anchors WHERE tenant_id = ?`,
    ).get(TENANT);
    const tail = db.prepare<{ record_hash: string }>(
      `SELECT record_hash FROM audit_log WHERE tenant_id = ? AND chain_seq = ?`,
    ).get(TENANT, 4);
    assert.equal(Number(anchor?.to_seq), 4);
    assert.equal(anchor?.tail_hash, tail?.record_hash);
    assert.equal(anchor?.key_id, 'test-kms-key');
  });

  it('is idempotent when triggerOnce is called twice for the same tail', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 3);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const service = createService(db, flags);

    await service.triggerOnce();
    await service.triggerOnce();

    const row = db.prepare<AnchorCountRow>(
      `SELECT COUNT(*) AS count FROM audit_chain_anchors WHERE tenant_id = ?`,
    ).get(TENANT);
    assert.equal(Number(row?.count), 1);
  });

  it('detects audit row tampering after a tail has been anchored', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 5);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const kms = new TestKmsProvider();
    const service = createService(db, flags, kms);
    await service.triggerOnce();

    /* 篡改一行 payload，链内的 record_hash 会与重新计算的不一致。 */
    db.prepare<void>(
      `UPDATE audit_log SET payload_json = ? WHERE tenant_id = ? AND chain_seq = ?`,
    ).run('{"tampered":true}', TENANT, 3);

    const result = await verifyAuditAnchors({ db, kmsProvider: kms });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.reason === 'chain_broken_before_anchor'));
  });

  it('skips signing when the feature flag is disabled', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 2);

    const flags = new FeatureFlagService();
    /* flag 默认 false — 不开启 */
    const service = createService(db, flags);
    const result = await service.triggerOnce();

    assert.equal(result.anchored.length, 0);
    assert.ok(result.skipped >= 1);

    const row = db.prepare<AnchorCountRow>(
      `SELECT COUNT(*) AS count FROM audit_chain_anchors`,
    ).get();
    assert.equal(Number(row?.count), 0);
  });

  it('fails restore-style verification when KMS verify is required but missing', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 2);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const service = createService(db, flags);
    await service.triggerOnce();

    /* 不注入 verify 能力，严格模式应该判定 error */
    const result = await verifyAuditAnchors({ db, requireSignatures: true });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue =>
      issue.reason === 'signature_not_verified' && issue.severity === 'error',
    ));
  });

  it('reports missing_anchor_for_tenant when an audited tenant has no anchors', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 2);

    /* flag 关闭 → 不会写锚；但 restore-check 要求每个 tenantId 都有锚 */
    const result = await verifyAuditAnchors({
      db,
      requireAnchorsForTenants: [TENANT],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue =>
      issue.reason === 'missing_anchor_for_tenant' && issue.severity === 'error',
    ));
  });

  it('handles platform-level audit rows (empty tenant_id) end-to-end through anchor + verify', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    /* 直接以空 tenant 写入 audit，模拟平台级事件 */
    for (let i = 0; i < 2; i += 1) {
      recordRequestAuditLog(db, {
        tenantId: '',
        requestId: `plat-${i}`,
        method: 'POST',
        path: `/platform/op/${i}`,
        statusCode: 200,
        latencyMs: 1,
        actionType: 'platform',
      });
    }

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const kms = new TestKmsProvider();
    const service = createService(db, flags, kms);
    const result = await service.triggerOnce();

    /* 锚被写入：tenantId='' (raw 形式存到 anchor 表)，报告 partitioned='platform' */
    assert.equal(result.anchored.length, 1);
    assert.equal(result.anchored[0]?.tenantId, 'platform');

    /* anchor 行的 tenant_id 应该是 raw '' — 而非 'platform' — 这样它和
     * audit_log.tenant_id 同形，verifier 能直接交叉查回。 */
    const anchorRow = db.prepare<{ tenant_id: string }>(
      `SELECT tenant_id FROM audit_chain_anchors LIMIT 1`,
    ).get();
    assert.equal(anchorRow?.tenant_id, '');

    /* verify 路径 OK：签名 payload 用 normalize 形式重建，链查询用 raw。 */
    const verifyResult = await verifyAuditAnchors({ db, kmsProvider: kms });
    assert.equal(verifyResult.ok, true, JSON.stringify(verifyResult));
  });

  it('verifier hard-times-out when kmsProvider.verify hangs', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 2);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const goodKms = new TestKmsProvider();
    await createService(db, flags, goodKms).triggerOnce();

    const hangingVerify: Pick<AuditChainKmsProvider, 'verify'> = {
      verify: () => new Promise(() => { /* never resolves */ }),
    };
    const raced = await Promise.race([
      verifyAuditAnchors({ db, kmsProvider: hangingVerify }).then(r => r),
      new Promise<'test-timeout'>(resolve => setTimeout(() => resolve('test-timeout'), 12_000)),
    ]);
    assert.notEqual(raced, 'test-timeout', 'verifier must complete within KMS hard timeout');
    const result = raced as { issues: Array<{ reason: string }> };
    assert.ok(result.issues.some(issue => issue.reason === 'signature_verify_failed'));
  });

  it('does not stall indefinitely when KMS sign hangs (bounded timeout)', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 1);

    const hangingKms: AuditChainKmsProvider = {
      sign: () => new Promise(() => { /* never resolves */ }),
    };
    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    /* 用 1ms 超时通过单元测试速率 — service 内 timeout 是 10s，
     * 我们用 setImmediate 触发后通过竞速验证不会 hang。 */
    const service = createService(db, flags, hangingKms);
    /* triggerOnce 应该最终拒绝（log error）并返回，而不是永远 pending。
     * 我们用 Promise.race 限定测试本身 12s 超时（service hard timeout = 10s）。 */
    const raced = await Promise.race([
      service.triggerOnce().then(() => 'completed'),
      new Promise<'test-timeout'>(resolve => setTimeout(() => resolve('test-timeout'), 12_000)),
    ]);
    assert.equal(raced, 'completed', 'triggerOnce must complete within KMS hard timeout');
  });

  it('persists a failure evidence row when KMS sign throws (GA §8 #1)', async () => {
    /* 失败应当写一行 audit_chain_anchor_failures，errorCode 按异常文本分类，
     * recovered_at 留空；listOpenAnchorFailures() 应该看到该行。 */
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 3);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);

    class RefusedKms implements AuditChainKmsProvider {
      async sign(): Promise<{ keyId: string; signature: string; alg: string }> {
        throw new Error('KMS request was refused: permission denied');
      }
    }
    const service = createService(db, flags, new RefusedKms());
    const result = await service.triggerOnce();
    assert.equal(result.anchored.length, 0);

    const open = service.listOpenAnchorFailures();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.tenantId, TENANT);
    assert.equal(open[0]!.errorCode, 'refused');
    assert.equal(open[0]!.recoveredAt, null);
    assert.ok(open[0]!.errorMessage.toLowerCase().includes('refused'));
  });

  it('marks failure evidence as recovered once a later anchor succeeds (GA §8 #1)', async () => {
    /* 先失败再成功：成功锚定后，上一次的失败行应被 markFailuresRecovered
     * 打上 recovered_at，从 open 列表里淘汰。 */
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 3);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);

    let throwOnce = true;
    class FlakyKms extends TestKmsProvider {
      override async sign(payload: Buffer): Promise<{ keyId: string; signature: string; alg: string }> {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('connection refused by KMS endpoint');
        }
        return super.sign(payload);
      }
    }
    const service = createService(db, flags, new FlakyKms());
    /* 第 1 次：失败 → 写 evidence */
    await service.triggerOnce();
    assert.equal(service.listOpenAnchorFailures().length, 1);

    /* 第 2 次：成功 → 清算 evidence */
    const second = await service.triggerOnce();
    assert.equal(second.anchored.length, 1);
    assert.equal(service.listOpenAnchorFailures().length, 0);

    const history = service.listAnchorFailuresForTenant(TENANT);
    assert.equal(history.length, 1);
    assert.ok(history[0]!.recoveredAt !== null);
  });

  it('binds the signature to (tenant, fromSeq, toSeq, tailHash) — replaying the same tailHash on another window is rejected', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    seedAuditRows(db, 3);

    const flags = new FeatureFlagService();
    flags.setEnabled('audit.kms-sign-chain-tail', true);
    flags.setRolloutPercent('audit.kms-sign-chain-tail', 100);
    const kms = new TestKmsProvider();
    const service = createService(db, flags, kms);
    await service.triggerOnce();

    /* 篡改 from_seq 模拟"重放同一签名到不同窗口"。 */
    db.prepare<void>(
      `UPDATE audit_chain_anchors SET from_seq = ? WHERE tenant_id = ?`,
    ).run(999, TENANT);

    const result = await verifyAuditAnchors({ db, kmsProvider: kms });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.reason === 'signature_invalid'));
  });
});
