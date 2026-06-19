/**
 * ChronoCompanion C 端基线行为边界（ADR-0046/0047/0054 共用）。
 *
 * 任何**主动或被动**发给 C 端用户的文本（chat 回应、response_template、主动 nudge）都必须过这套
 * never_discuss 自检——把基线敏感主题集中在一处，避免各路由各自维护一份导致漂移。
 */

import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';

/** C 端基线 never_discuss 主题——**中英双语等价**（ADR-0055 内容多语）：
 * 记忆翻译成英文后，敏感主题的英文译文（如「密码」→「password」）也必须被输出自检拦住，
 * 否则英文 query 命中英文译文会绕过纯中文边界（Codex 复审 High）。matcher 是 lowercase 子串，
 * 故英文项用小写。 */
export const COMPANION_BASELINE_BOUNDARIES: BehaviorBoundary[] = [
  { rule: 'never_discuss', topic: '密码' },
  { rule: 'never_discuss', topic: '口令' },
  { rule: 'never_discuss', topic: '密钥' },
  { rule: 'never_discuss', topic: 'api key' },
  { rule: 'never_discuss', topic: '银行卡号' },
  { rule: 'never_discuss', topic: '身份证号' },
  /* 英文等价（含上述敏感主题的常见英文表述 + 常见凭证类术语）。 */
  { rule: 'never_discuss', topic: 'password' },
  { rule: 'never_discuss', topic: 'passcode' },
  { rule: 'never_discuss', topic: 'secret key' },
  { rule: 'never_discuss', topic: 'private key' },
  { rule: 'never_discuss', topic: 'api token' },
  { rule: 'never_discuss', topic: 'access token' },
  { rule: 'never_discuss', topic: 'bearer token' },
  { rule: 'never_discuss', topic: 'bank card number' },
  { rule: 'never_discuss', topic: 'card number' },
  { rule: 'never_discuss', topic: 'id number' },
  { rule: 'never_discuss', topic: 'social security' },
  /* 多词项才加（短缩写如 pin/ssn/cvv 子串匹配会误伤 shopping/lesson 等，不加）。 */
  { rule: 'never_discuss', topic: 'social security number' },
  { rule: 'never_discuss', topic: 'pin code' },
  { rule: 'never_discuss', topic: 'cvv code' },
  { rule: 'never_discuss', topic: 'security code' },
  { rule: 'never_discuss', topic: 'seed phrase' },
  { rule: 'never_discuss', topic: 'recovery phrase' },
];
