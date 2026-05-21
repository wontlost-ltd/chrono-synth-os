/**
 * P0-C 否定测试 — SIEM 投递失败 / 篡改尝试（前置依赖未到位）
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §8 #22
 *
 * 此测试 SKIP 直到 P1-Q-3 (SIEM basic export, CEF/syslog) 完成，
 * 该任务在 Phase 2 W53-W55 实施。
 *
 * P1-Q-3 完成后，移除 t.skip 并填充：
 *   - SIEM endpoint 不可达 → 本地 buffer 累积 + retry，不丢事件
 *   - 投递返回 4xx → 标记 dead-letter 且告警
 *   - SIEM 接收方变化 message structure → schema validation 拒绝旧/新 schema 混合
 *   - 不可在不重放 audit log 的前提下回填 SIEM gap
 *
 * Acceptance: §8 #22 SIEM basic export CEF/syslog 可用 + 不丢事件 + dead-letter 告警。
 */

import { test } from 'node:test';

test('P0-C negative — SIEM delivery failure (placeholder)', { skip: 'waiting for P1-Q-3 (SIEM basic export) — Phase 2 W53-W55' }, () => {
  /* placeholder; see file header for activation criteria */
});
