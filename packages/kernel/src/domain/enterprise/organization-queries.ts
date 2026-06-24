/**
 * 组织管理 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const ORG_QUERY_LIST_BY_USER = 'org.listByUser' as const;
export const ORG_QUERY_BY_SLUG = 'org.bySlug' as const;
export const ORG_QUERY_BY_ID = 'org.byId' as const;
export const ORG_QUERY_MEMBERS = 'org.members' as const;
export const ORG_QUERY_ROLE_BINDINGS = 'org.roleBindings' as const;
/** 批量取整组织全部成员的角色绑定（消 listMembers 的 N+1），行带 membership_id 供内存分组 */
export const ORG_QUERY_ROLE_BINDINGS_BY_ORG = 'org.roleBindingsByOrg' as const;
export const ORG_QUERY_USER_BY_ID = 'org.userById' as const;
export const ORG_QUERY_USER_BY_EMAIL = 'org.userByEmail' as const;
export const ORG_QUERY_WORKSPACE_BY_ID = 'org.workspaceById' as const;
export const ORG_QUERY_MEMBERSHIP = 'org.membership' as const;
export const ORG_QUERY_ROLE_BINDING_EXISTS = 'org.roleBindingExists' as const;
export const ORG_QUERY_ROLE_BINDING_EXISTS_WS = 'org.roleBindingExistsWs' as const;
export const ORG_QUERY_ORG_ROW = 'org.orgRow' as const;
export const ORG_QUERY_WORKSPACE_ROW = 'org.workspaceRow' as const;
export const ORG_QUERY_ACTIVE_MEMBERSHIP = 'org.activeMembership' as const;
export const ORG_QUERY_MEMBERSHIP_ROLES = 'org.membershipRoles' as const;
export const ORG_QUERY_TENANT_USER_EMAIL = 'org.tenantUserEmail' as const;

/* ── Command Kinds ── */

export const ORG_CMD_CREATE_ORG = 'org.createOrg' as const;
export const ORG_CMD_CREATE_WORKSPACE = 'org.createWorkspace' as const;
export const ORG_CMD_CREATE_MEMBERSHIP = 'org.createMembership' as const;
export const ORG_CMD_CREATE_ROLE_BINDING = 'org.createRoleBinding' as const;
export const ORG_CMD_UPDATE_MEMBERSHIP_ACTIVE = 'org.updateMembershipActive' as const;

/* ── 行类型 ── */

export interface OrgListByUserRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly slug: string;
  readonly created_by_user_id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly workspace_id: string | null;
  readonly workspace_name: string | null;
  readonly workspace_slug: string | null;
  readonly workspace_is_default: number | null;
  readonly workspace_created_at: number | null;
  readonly workspace_updated_at: number | null;
}

export interface OrgIdRow {
  readonly id: string;
}

export interface OrgRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly slug: string;
  readonly created_by_user_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface OrgWorkspaceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly slug: string;
  readonly is_default: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface OrgMemberRow {
  readonly membership_id: string;
  readonly user_id: string;
  readonly email: string;
  readonly status: string;
  readonly created_at: number;
}

export interface OrgRoleBindingRow {
  readonly role: string;
  readonly workspace_id: string | null;
  readonly workspace_name: string | null;
}

/** 批量绑定行：比 OrgRoleBindingRow 多带 membership_id，供按成员内存分组 */
export interface OrgRoleBindingByOrgRow {
  readonly membership_id: string;
  readonly role: string;
  readonly workspace_id: string | null;
  readonly workspace_name: string | null;
}

export interface OrgUserRow {
  readonly id: string;
  readonly email: string;
}

export interface OrgActiveMembershipRow {
  readonly membership_id: string;
  readonly organization_id: string;
  readonly user_id: string;
}

export interface OrgMembershipRoleRow {
  readonly role: string;
}

export interface OrgTenantUserEmailRow {
  readonly email: string;
}

/* ── 参数类型 ── */

export interface OrgTenantUserParams {
  tenantId: string;
  userId: string;
}

export interface OrgTenantSlugParams {
  tenantId: string;
  slug: string;
}

export interface OrgTenantIdParams {
  tenantId: string;
  id: string;
}

export interface OrgMembersParams {
  tenantId: string;
  organizationId: string;
}

export interface OrgRoleBindingsParams {
  tenantId: string;
  organizationId: string;
  membershipId: string;
}

export interface OrgWorkspaceByIdParams {
  tenantId: string;
  organizationId: string;
  workspaceId: string;
}

export interface OrgMembershipParams {
  tenantId: string;
  organizationId: string;
  userId: string;
}

export interface OrgRoleBindingExistsParams {
  tenantId: string;
  organizationId: string;
  membershipId: string;
  role: string;
}

export interface OrgRoleBindingExistsWsParams {
  tenantId: string;
  organizationId: string;
  membershipId: string;
  role: string;
  workspaceId: string;
}

export interface OrgCreateOrgParams {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  createdByUserId: string;
  now: number;
}

export interface OrgCreateWorkspaceParams {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  slug: string;
  now: number;
}

export interface OrgCreateMembershipParams {
  id: string;
  tenantId: string;
  organizationId: string;
  userId: string;
  now: number;
}

export interface OrgCreateRoleBindingParams {
  id: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string | null;
  membershipId: string;
  role: string;
  now: number;
}

export interface OrgUpdateMembershipActiveParams {
  tenantId: string;
  organizationId: string;
  userId: string;
  now: number;
}

/* ── Query 工厂 ── */

export function orgQueryListByUser(params: OrgTenantUserParams): Query<OrgListByUserRow, OrgTenantUserParams> {
  return { kind: ORG_QUERY_LIST_BY_USER, params };
}

export function orgQueryBySlug(params: OrgTenantSlugParams): Query<OrgIdRow | null, OrgTenantSlugParams> {
  return { kind: ORG_QUERY_BY_SLUG, params };
}

export function orgQueryById(params: OrgTenantIdParams): Query<OrgIdRow | null, OrgTenantIdParams> {
  return { kind: ORG_QUERY_BY_ID, params };
}

export function orgQueryMembers(params: OrgMembersParams): Query<OrgMemberRow, OrgMembersParams> {
  return { kind: ORG_QUERY_MEMBERS, params };
}

export function orgQueryRoleBindings(params: OrgRoleBindingsParams): Query<OrgRoleBindingRow, OrgRoleBindingsParams> {
  return { kind: ORG_QUERY_ROLE_BINDINGS, params };
}

/** 批量：一次取整组织全部成员的角色绑定（消 N+1），按 membership_id 内存分组 */
export function orgQueryRoleBindingsByOrg(params: OrgMembersParams): Query<OrgRoleBindingByOrgRow, OrgMembersParams> {
  return { kind: ORG_QUERY_ROLE_BINDINGS_BY_ORG, params };
}

export function orgQueryUserById(params: OrgTenantIdParams): Query<OrgUserRow | null, OrgTenantIdParams> {
  return { kind: ORG_QUERY_USER_BY_ID, params };
}

export function orgQueryUserByEmail(params: OrgTenantSlugParams): Query<OrgUserRow | null, OrgTenantSlugParams> {
  return { kind: ORG_QUERY_USER_BY_EMAIL, params };
}

export function orgQueryWorkspaceById(params: OrgWorkspaceByIdParams): Query<OrgIdRow | null, OrgWorkspaceByIdParams> {
  return { kind: ORG_QUERY_WORKSPACE_BY_ID, params };
}

export function orgQueryMembership(params: OrgMembershipParams): Query<OrgIdRow | null, OrgMembershipParams> {
  return { kind: ORG_QUERY_MEMBERSHIP, params };
}

export function orgQueryRoleBindingExists(params: OrgRoleBindingExistsParams): Query<OrgIdRow | null, OrgRoleBindingExistsParams> {
  return { kind: ORG_QUERY_ROLE_BINDING_EXISTS, params };
}

export function orgQueryRoleBindingExistsWs(params: OrgRoleBindingExistsWsParams): Query<OrgIdRow | null, OrgRoleBindingExistsWsParams> {
  return { kind: ORG_QUERY_ROLE_BINDING_EXISTS_WS, params };
}

export function orgQueryOrgRow(params: OrgTenantIdParams): Query<OrgRow | null, OrgTenantIdParams> {
  return { kind: ORG_QUERY_ORG_ROW, params };
}

export function orgQueryWorkspaceRow(params: OrgTenantIdParams): Query<OrgWorkspaceRow | null, OrgTenantIdParams> {
  return { kind: ORG_QUERY_WORKSPACE_ROW, params };
}

export function orgQueryActiveMembership(params: OrgMembershipParams): Query<OrgActiveMembershipRow | null, OrgMembershipParams> {
  return { kind: ORG_QUERY_ACTIVE_MEMBERSHIP, params };
}

export function orgQueryMembershipRoles(params: OrgRoleBindingsParams): Query<OrgMembershipRoleRow, OrgRoleBindingsParams> {
  return { kind: ORG_QUERY_MEMBERSHIP_ROLES, params };
}

export function orgQueryTenantUserEmail(tenantId: string): Query<OrgTenantUserEmailRow | null, string> {
  return { kind: ORG_QUERY_TENANT_USER_EMAIL, params: tenantId };
}

/* ── Command 工厂 ── */

export function orgCmdCreateOrg(params: OrgCreateOrgParams): Command<OrgCreateOrgParams> {
  return { kind: ORG_CMD_CREATE_ORG, params };
}

export function orgCmdCreateWorkspace(params: OrgCreateWorkspaceParams): Command<OrgCreateWorkspaceParams> {
  return { kind: ORG_CMD_CREATE_WORKSPACE, params };
}

export function orgCmdCreateMembership(params: OrgCreateMembershipParams): Command<OrgCreateMembershipParams> {
  return { kind: ORG_CMD_CREATE_MEMBERSHIP, params };
}

export function orgCmdCreateRoleBinding(params: OrgCreateRoleBindingParams): Command<OrgCreateRoleBindingParams> {
  return { kind: ORG_CMD_CREATE_ROLE_BINDING, params };
}

export function orgCmdUpdateMembershipActive(params: OrgUpdateMembershipActiveParams): Command<OrgUpdateMembershipActiveParams> {
  return { kind: ORG_CMD_UPDATE_MEMBERSHIP_ACTIVE, params };
}
