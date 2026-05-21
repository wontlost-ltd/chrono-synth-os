/**
 * P0-C 否定测试 — Break-glass 应急令牌过期 / 滥用尝试（前置依赖未到位）
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §8 #15
 *
 * 此测试 SKIP 直到 P1-M (身份生命周期 - break-glass admin) 完成，
 * 该任务在 Phase 1B W35-W38 实施。
 *
 * P1-M 完成后，移除 t.skip 并填充：
 *   - 过期签名 token 必拒（exp < now）
 *   - 超出 scope 的操作必拒（read-only token 用于 write）
 *   - 不存在审批记录的 emergency override 必拒
 *   - 撤销列表中的 token 必拒
 *   - 重复使用同一 jti 必拒（jti 单次消费）
 *
 * Acceptance: §8 #15 break-glass 控制 = 签名 token + 到期 + scope + 审批 + 审计告警。
 */

import { test } from 'node:test';

test('P0-C negative — break-glass expired (placeholder)', { skip: 'waiting for P1-M (break-glass admin) — Phase 1B W35-W38' }, () => {
  /* placeholder; see file header for activation criteria */
});
