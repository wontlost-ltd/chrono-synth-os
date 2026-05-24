/**
 * P1-O — FeatureFlagService tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeatureFlagService, FEATURE_FLAGS, type FlagKey } from '../../feature-flags/feature-flag-service.js';
import { EventBus } from '../../events/event-bus.js';

const ANY_FLAG: FlagKey = 'agent.long-context-mode';

describe('FeatureFlagService — defaults', () => {
  it('exposes every declared flag', () => {
    const svc = new FeatureFlagService();
    for (const key of Object.keys(FEATURE_FLAGS) as FlagKey[]) {
      const snap = svc.snapshot(key);
      assert.equal(typeof snap.enabled, 'boolean');
    }
  });

  it('default-enabled flags return true on isEnabled', () => {
    const svc = new FeatureFlagService();
    /* memory.semantic-pruning has defaultEnabled: true */
    const d = svc.isEnabled('memory.semantic-pruning', 't1');
    assert.equal(d.enabled, true);
  });

  it('default-disabled flags return false', () => {
    const svc = new FeatureFlagService();
    const d = svc.isEnabled(ANY_FLAG, 't1');
    assert.equal(d.enabled, false);
  });
});

describe('FeatureFlagService — rollout percentages', () => {
  it('rolloutPercent=100 enables for everyone', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 100);
    assert.equal(svc.isEnabled(ANY_FLAG, 't1').enabled, true);
    assert.equal(svc.isEnabled(ANY_FLAG, 't2').enabled, true);
    assert.equal(svc.isEnabled(ANY_FLAG, 't3').enabled, true);
  });

  it('rolloutPercent=0 disables for everyone', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 0);
    assert.equal(svc.isEnabled(ANY_FLAG, 't1').enabled, false);
  });

  it('rolloutPercent=50 buckets approximately half of tenants', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 50);
    let on = 0;
    const N = 1000;
    for (let i = 0; i < N; i += 1) {
      if (svc.isEnabled(ANY_FLAG, `tenant-${i}`).enabled) on += 1;
    }
    /* Expected ~500; allow ±15% tolerance for the hash distribution. */
    assert.ok(on > 350 && on < 650, `bucket distribution drift: got ${on}/${N}`);
  });

  it('bucketing is stable — same tenant gets the same answer twice', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 50);
    const first = svc.isEnabled(ANY_FLAG, 'tenant-xyz').enabled;
    const second = svc.isEnabled(ANY_FLAG, 'tenant-xyz').enabled;
    assert.equal(first, second);
  });

  it('rejects invalid rolloutPercent', () => {
    const svc = new FeatureFlagService();
    assert.throws(() => svc.setRolloutPercent(ANY_FLAG, -1), /\[0, 100\]/);
    assert.throws(() => svc.setRolloutPercent(ANY_FLAG, 101), /\[0, 100\]/);
    assert.throws(() => svc.setRolloutPercent(ANY_FLAG, Number.NaN), /\[0, 100\]/);
  });
});

describe('FeatureFlagService — per-tenant overrides', () => {
  it('allowlist wins over rolloutPercent=0', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 0);
    svc.allowTenant(ANY_FLAG, 'vip-tenant');
    assert.equal(svc.isEnabled(ANY_FLAG, 'vip-tenant').enabled, true);
    assert.equal(svc.isEnabled(ANY_FLAG, 'normal').enabled, false);
  });

  it('denylist wins over rolloutPercent=100', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 100);
    svc.denyTenant(ANY_FLAG, 'problem-tenant');
    assert.equal(svc.isEnabled(ANY_FLAG, 'problem-tenant').enabled, false);
    assert.equal(svc.isEnabled(ANY_FLAG, 'normal').enabled, true);
  });

  it('moving a tenant from allowlist to denylist removes the allow', () => {
    const svc = new FeatureFlagService();
    svc.allowTenant(ANY_FLAG, 't1');
    svc.denyTenant(ANY_FLAG, 't1');
    /* After flipping: not in allowlist, still in denylist. */
    const snap = svc.snapshot(ANY_FLAG);
    assert.equal(snap.allowlistCount, 0);
    assert.equal(snap.denylistCount, 1);
  });
});

describe('FeatureFlagService — kill switch (incident response)', () => {
  it('kill() overrides allowlist + rollout + enabled', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 100);
    svc.allowTenant(ANY_FLAG, 'vip-tenant');
    svc.kill(ANY_FLAG);
    const d = svc.isEnabled(ANY_FLAG, 'vip-tenant');
    assert.equal(d.enabled, false);
    assert.equal(d.reason, 'killed');
  });

  it('revive() restores previous semantics', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 100);
    svc.kill(ANY_FLAG);
    assert.equal(svc.isEnabled(ANY_FLAG, 't1').enabled, false);
    svc.revive(ANY_FLAG);
    assert.equal(svc.isEnabled(ANY_FLAG, 't1').enabled, true);
  });
});

describe('FeatureFlagService — platform-wide query (tenantId=null)', () => {
  it('100% rollout passes platform-wide', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 100);
    assert.equal(svc.isEnabled(ANY_FLAG, null).enabled, true);
  });

  it('partial rollout fails platform-wide (conservative)', () => {
    const svc = new FeatureFlagService();
    svc.setEnabled(ANY_FLAG, true);
    svc.setRolloutPercent(ANY_FLAG, 50);
    /* No tenant context → can't bucket → conservative off. */
    assert.equal(svc.isEnabled(ANY_FLAG, null).enabled, false);
  });
});

describe('FeatureFlagService — snapshots', () => {
  it('snapshotAll lists every declared flag', () => {
    const svc = new FeatureFlagService();
    const all = svc.snapshotAll();
    assert.equal(all.length, Object.keys(FEATURE_FLAGS).length);
  });
});

describe('FeatureFlagService — bus events', () => {
  it('emits feature-flag:changed on setEnabled', () => {
    const bus = new EventBus();
    const svc = new FeatureFlagService({ bus });
    const events: Array<{ flag: string; enabled: boolean }> = [];
    bus.on('feature-flag:changed', (p) => { events.push(p); });

    svc.setEnabled(ANY_FLAG, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.flag, ANY_FLAG);
    assert.equal(events[0]?.enabled, true);
  });

  it('emits on kill + revive (incident response)', () => {
    const bus = new EventBus();
    const svc = new FeatureFlagService({ bus });
    let killedCount = 0;
    bus.on('feature-flag:changed', (p) => { if (p.killed) killedCount += 1; });

    svc.kill(ANY_FLAG);
    svc.revive(ANY_FLAG);
    /* kill emits killed=true, revive emits killed=false → only the
     * first event has killed=true. */
    assert.equal(killedCount, 1);
  });

  it('emits on allow/denyTenant so SSE clients recompute per-tenant', () => {
    /* The payload doesn't carry tenant IDs (tenant override membership
     * stays server-private). SSE consumers see a generic change event
     * and re-run isEnabled() against their own tenantId. */
    const bus = new EventBus();
    const svc = new FeatureFlagService({ bus });
    let count = 0;
    bus.on('feature-flag:changed', (p) => {
      count += 1;
      /* Generic shape only — no tenant info. */
      assert.equal('tenantId' in p, false);
    });

    svc.allowTenant(ANY_FLAG, 'tenant-a');
    svc.denyTenant(ANY_FLAG, 'tenant-b');
    assert.equal(count, 2);
  });

  it('emits rolloutPercent updates', () => {
    const bus = new EventBus();
    const svc = new FeatureFlagService({ bus });
    const captured: number[] = [];
    bus.on('feature-flag:changed', (p) => { captured.push(p.rolloutPercent); });

    svc.setRolloutPercent(ANY_FLAG, 25);
    svc.setRolloutPercent(ANY_FLAG, 75);
    assert.deepEqual(captured, [25, 75]);
  });

  it('no-bus constructor still works (back-compat)', () => {
    const svc = new FeatureFlagService();
    /* Should not throw even though there's no bus to emit on. */
    svc.setEnabled(ANY_FLAG, true);
    assert.equal(svc.snapshot(ANY_FLAG).enabled, true);
  });
});
