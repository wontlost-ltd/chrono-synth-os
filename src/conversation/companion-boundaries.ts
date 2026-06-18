/**
 * ChronoCompanion C 端基线行为边界（ADR-0046/0047/0054 共用）。
 *
 * 任何**主动或被动**发给 C 端用户的文本（chat 回应、response_template、主动 nudge）都必须过这套
 * never_discuss 自检——把基线敏感主题集中在一处，避免各路由各自维护一份导致漂移。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';

/** C 端基线 never_discuss 主题（密码/口令/密钥/卡号/证件号等）。 */
export const COMPANION_BASELINE_BOUNDARIES: BehaviorBoundary[] = [
  { rule: 'never_discuss', topic: '密码' },
  { rule: 'never_discuss', topic: '口令' },
  { rule: 'never_discuss', topic: '密钥' },
  { rule: 'never_discuss', topic: 'api key' },
  { rule: 'never_discuss', topic: '银行卡号' },
  { rule: 'never_discuss', topic: '身份证号' },
];
