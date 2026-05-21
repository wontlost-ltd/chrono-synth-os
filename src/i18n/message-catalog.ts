/**
 * 消息字典 — 错误消息 + 标准 UI 字符串的英 / 中文版本。
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-E-ext
 *
 * 写在源码里（不是 JSON 文件）是 v1 的有意选择：
 *   - 编译期 TS 类型检查 catch 拼写错误（vs 运行时 lookup-failure）。
 *   - 没有运行时文件读取 → 不需要打包外加资源。
 *   - 当条目数增长（>50）再考虑外置；目前 10-20 个错误消息打着不痛。
 *
 * 添加新 key：在 MessageKey 联合类型加常量，然后两边 catalog 各填一项；
 * TS 会在 catalog 缺 key 时直接报错。
 */

import type { SupportedLocale } from './locale-resolver.js';

export type MessageKey =
  | 'auth.invalid_credentials'
  | 'auth.token_expired'
  | 'auth.token_revoked'
  | 'auth.kid_revoked'
  | 'auth.role_required'
  | 'auth.rotate_restart_required'
  | 'validation.required_field'
  | 'validation.out_of_range'
  | 'validation.type_mismatch'
  | 'quota.exceeded'
  | 'quota.plan_limit'
  | 'notfound.value'
  | 'notfound.persona'
  | 'notfound.session'
  | 'state.invalid_transition'
  | 'storage.tenant_isolation_violation'
  | 'storage.constraint_violation'
  | 'config.missing_env';

type Catalog = Record<MessageKey, string>;

const en: Catalog = {
  'auth.invalid_credentials': 'Invalid email or password',
  'auth.token_expired': 'Authentication token has expired',
  'auth.token_revoked': 'This token has been revoked',
  'auth.kid_revoked': 'Token signing key is no longer accepted',
  'auth.role_required': 'This operation requires {role} role',
  'auth.rotate_restart_required': 'Rotating to a different active key requires a config update and process restart',
  'validation.required_field': '{field} is required',
  'validation.out_of_range': '{field} must be between {min} and {max}',
  'validation.type_mismatch': '{field} must be of type {expected}',
  'quota.exceeded': 'Quota exceeded for {resource}',
  'quota.plan_limit': 'Your current plan does not include {feature}',
  'notfound.value': 'Value with id {id} was not found',
  'notfound.persona': 'Persona with id {id} was not found',
  'notfound.session': 'Session not found or expired',
  'state.invalid_transition': 'Cannot transition from {from} to {to}',
  'storage.tenant_isolation_violation': 'Operation crossed tenant boundary',
  'storage.constraint_violation': 'Operation violates a database constraint',
  'config.missing_env': 'Required environment variable {name} is not set',
};

const zhCN: Catalog = {
  'auth.invalid_credentials': '邮箱或密码不正确',
  'auth.token_expired': '认证令牌已过期',
  'auth.token_revoked': '该令牌已被吊销',
  'auth.kid_revoked': '令牌签名密钥已不再受理',
  'auth.role_required': '该操作需要 {role} 角色',
  'auth.rotate_restart_required': '切换签名密钥需要更新配置并重启进程',
  'validation.required_field': '{field} 为必填项',
  'validation.out_of_range': '{field} 必须在 {min} 与 {max} 之间',
  'validation.type_mismatch': '{field} 必须为 {expected} 类型',
  'quota.exceeded': '{resource} 配额已用尽',
  'quota.plan_limit': '当前订阅不包含 {feature}',
  'notfound.value': '未找到 id 为 {id} 的价值条目',
  'notfound.persona': '未找到 id 为 {id} 的人格',
  'notfound.session': '会话不存在或已过期',
  'state.invalid_transition': '无法从状态 {from} 转移到 {to}',
  'storage.tenant_isolation_violation': '操作跨越了租户边界',
  'storage.constraint_violation': '操作违反数据库约束',
  'config.missing_env': '必需的环境变量 {name} 未设置',
};

const CATALOGS: Record<SupportedLocale, Catalog> = {
  en,
  'zh-CN': zhCN,
};

/**
 * Format a localised message. Placeholders use `{name}` syntax. Unknown
 * placeholders are left in place rather than throwing — easier debugging
 * than a silent ValidationError from inside the i18n layer.
 */
export function t(
  locale: SupportedLocale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS.en[key];
  if (!template) {
    /* This branch is unreachable given TS narrowing on MessageKey, but
     * defensive: return the key itself so the UI shows something traceable
     * rather than `undefined`. */
    return key;
  }
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (name in params) return String(params[name]);
    return `{${name}}`;
  });
}
