/**
 * 组织角色定义 — 领域层共享类型
 * 被 organization-rbac 插件和 OrganizationService 共同引用
 */

export const ORGANIZATION_ROLES = [
  'org_admin',
  'billing_admin',
  'persona_operator',
  'marketplace_manager',
  'auditor',
  'viewer',
] as const;

export type OrganizationRole = typeof ORGANIZATION_ROLES[number];
