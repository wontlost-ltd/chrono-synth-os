/**
 * 审计哈希链纯函数单元测试 — 验证 canonical 序列化与链验证逻辑
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-E
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GENESIS_HASH, computeRecordHash, verifyChain,
  type AuditHashInput, type VerifiableRow,
} from '../../audit/audit-hash-chain.js';

function makeInput(seq: number, prevHash: string, payload: string | null = null): AuditHashInput {
  return {
    id: `id-${seq}`,
    tenantId: 'tenant-a',
    eventKind: 'request',
    createdAt: 1_700_000_000_000 + seq,
    chainSeq: seq,
    prevHash,
    method: 'GET',
    path: `/api/${seq}`,
    requestId: `req-${seq}`,
    statusCode: 200,
    latencyMs: 10,
    apiKeyHash: null,
    userId: null,
    userEmail: null,
    actorType: null,
    actorId: null,
    actionType: 'read',
    targetType: null,
    targetId: null,
    payloadJson: payload,
  };
}

describe('audit-hash-chain — computeRecordHash', () => {
  it('produces 64-char hex SHA-256', () => {
    const hash = computeRecordHash(makeInput(1, GENESIS_HASH));
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('is deterministic — same input yields same hash', () => {
    const input = makeInput(1, GENESIS_HASH);
    assert.equal(computeRecordHash(input), computeRecordHash(input));
  });

  it('changes when any field changes', () => {
    const base = makeInput(1, GENESIS_HASH);
    const mutated: AuditHashInput = { ...base, path: '/api/different' };
    assert.notEqual(computeRecordHash(base), computeRecordHash(mutated));
  });

  it('is key-order independent in canonical serialisation', () => {
    /* 该测试确保 canonical serialise 不依赖 input 字段声明顺序 */
    const a = makeInput(1, GENESIS_HASH);
    const b: AuditHashInput = {
      payloadJson: null,
      targetId: null,
      targetType: null,
      actionType: 'read',
      actorId: null,
      actorType: null,
      userEmail: null,
      userId: null,
      apiKeyHash: null,
      latencyMs: 10,
      statusCode: 200,
      requestId: 'req-1',
      path: '/api/1',
      method: 'GET',
      prevHash: GENESIS_HASH,
      chainSeq: 1,
      createdAt: 1_700_000_000_001,
      eventKind: 'request',
      tenantId: 'tenant-a',
      id: 'id-1',
    };
    assert.equal(computeRecordHash(a), computeRecordHash(b));
  });
});

describe('audit-hash-chain — verifyChain', () => {
  function buildHonestChain(length: number): VerifiableRow[] {
    const rows: VerifiableRow[] = [];
    let prevHash = GENESIS_HASH;
    for (let i = 1; i <= length; i += 1) {
      const input = makeInput(i, prevHash);
      const recordHash = computeRecordHash(input);
      rows.push({ ...input, recordHash });
      prevHash = recordHash;
    }
    return rows;
  }

  it('returns ok for an empty chain', () => {
    const result = verifyChain([]);
    assert.equal(result.ok, true);
    assert.equal(result.totalChecked, 0);
  });

  it('returns ok for a single genesis row', () => {
    const result = verifyChain(buildHonestChain(1));
    assert.equal(result.ok, true);
    assert.equal(result.totalChecked, 1);
  });

  it('returns ok for a multi-row clean chain', () => {
    const result = verifyChain(buildHonestChain(10));
    assert.equal(result.ok, true);
    assert.equal(result.breaks.length, 0);
  });

  it('detects record_hash mismatch (payload tampered after hashing)', () => {
    const rows = buildHonestChain(5);
    /* 篡改第 3 行的 payload — 但 record_hash 仍是篡改前的 */
    rows[2] = { ...rows[2], payloadJson: '{"hacked":1}' };

    const result = verifyChain(rows);
    assert.equal(result.ok, false);
    assert.ok(result.breaks.some(b => b.chainSeq === 3 && b.reason === 'record_hash_mismatch'));
  });

  it('detects prev_hash mismatch (chain broken in the middle)', () => {
    const rows = buildHonestChain(5);
    /* 改第 3 行的 prev_hash 为伪造值 */
    rows[2] = { ...rows[2], prevHash: 'a'.repeat(64) };

    const result = verifyChain(rows);
    assert.equal(result.ok, false);
    assert.ok(result.breaks.some(b => b.chainSeq === 3 && b.reason === 'prev_hash_mismatch'));
  });

  it('detects seq_gap (missing row)', () => {
    const rows = buildHonestChain(5);
    /* 删除第 3 行 */
    const tampered = [rows[0], rows[1], rows[3], rows[4]];

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.ok(result.breaks.some(b => b.reason === 'seq_gap'));
  });

  it('payload mutation flags exactly the tampered row', () => {
    /* 仅篡改 payload，stored record_hash 与 stored prev_hash 不动：
     * verifyChain 只会标记被篡改行（record_hash 重算与存储不符），
     * 下游行的 prev_hash 仍指向被篡改行的 *stored* record_hash 因此通过。
     *
     * 真正的链式失败需要同时把 stored record_hash 改成新值（参见 'tamper +
     * recompute' 测试），那样下游所有行的 prev_hash 都会失配。 */
    const rows = buildHonestChain(5);
    rows[1] = { ...rows[1], payloadJson: '{"x":1}' };

    const result = verifyChain(rows);
    assert.equal(result.ok, false);
    const seqs = new Set(result.breaks.map(b => b.chainSeq));
    assert.ok(seqs.has(2));
    assert.equal(result.breaks.length, 1, '只应标记 1 个失配点（被篡改行）');
  });

  it('propagates breaks downstream when stored record_hash is rewritten', () => {
    /* 攻击者尝试隐藏篡改：改 payload 后用新 hash 覆盖 record_hash。
     * 这会让被篡改行自身通过，但下游所有行的 stored prev_hash 失配。 */
    const rows = buildHonestChain(5);
    const tamperedInput = { ...rows[1], payloadJson: '{"x":1}' };
    const tamperedHash = computeRecordHash(tamperedInput);
    rows[1] = { ...tamperedInput, recordHash: tamperedHash };

    const result = verifyChain(rows);
    assert.equal(result.ok, false, `expected ok=false, got breaks=${JSON.stringify(result.breaks)}`);
    /* row 2 自身通过；row 3 prev_hash 链式失败（row 4..5 仍能 chain forward
     * if they reference row 3's *stored* hash, so only the first downstream
     * break is guaranteed). */
    const breaksBySeq = new Map(result.breaks.map(b => [b.chainSeq, b]));
    assert.equal(breaksBySeq.has(2), false, `行 2 在攻击重算后自身应通过，但实际 breaks=${JSON.stringify(result.breaks)}`);
    assert.equal(breaksBySeq.get(3)?.reason, 'prev_hash_mismatch');
  });
});
