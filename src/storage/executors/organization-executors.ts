/**
 * 组织管理 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  ORG_QUERY_LIST_BY_USER, ORG_QUERY_BY_SLUG, ORG_QUERY_BY_ID,
  ORG_QUERY_MEMBERS, ORG_QUERY_ROLE_BINDINGS,
  ORG_QUERY_USER_BY_ID, ORG_QUERY_USER_BY_EMAIL,
  ORG_QUERY_WORKSPACE_BY_ID, ORG_QUERY_MEMBERSHIP,
  ORG_QUERY_ROLE_BINDING_EXISTS, ORG_QUERY_ROLE_BINDING_EXISTS_WS,
  ORG_QUERY_ORG_ROW, ORG_QUERY_WORKSPACE_ROW,
  ORG_CMD_CREATE_ORG, ORG_CMD_CREATE_WORKSPACE,
  ORG_CMD_CREATE_MEMBERSHIP, ORG_CMD_CREATE_ROLE_BINDING,
  ORG_CMD_UPDATE_MEMBERSHIP_ACTIVE,
} from '@chrono/kernel';
import type {
  OrgListByUserRow, OrgIdRow, OrgRow, OrgWorkspaceRow,
  OrgMemberRow, OrgRoleBindingRow, OrgUserRow,
  OrgTenantUserParams, OrgTenantSlugParams, OrgTenantIdParams,
  OrgMembersParams, OrgRoleBindingsParams, OrgWorkspaceByIdParams,
  OrgMembershipParams, OrgRoleBindingExistsParams, OrgRoleBindingExistsWsParams,
  OrgCreateOrgParams, OrgCreateWorkspaceParams,
  OrgCreateMembershipParams, OrgCreateRoleBindingParams,
  OrgUpdateMembershipActiveParams,
} from '@chrono/kernel';

export function registerOrganizationExecutors(): void {
  registerQuery<readonly OrgListByUserRow[], OrgTenantUserParams>(ORG_QUERY_LIST_BY_USER, (db, p) => {
    return db.prepare<OrgListByUserRow>(
      `SELECT
        o.*,
        w.id AS workspace_id,
        w.name AS workspace_name,
        w.slug AS workspace_slug,
        w.is_default AS workspace_is_default,
        w.created_at AS workspace_created_at,
        w.updated_at AS workspace_updated_at
       FROM organizations o
       INNER JOIN organization_memberships m
         ON m.organization_id = o.id
        AND m.tenant_id = o.tenant_id
        AND m.status = 'active'
       LEFT JOIN workspaces w
         ON w.organization_id = o.id
        AND w.tenant_id = o.tenant_id
        AND w.is_default = 1
       WHERE o.tenant_id = ? AND m.user_id = ?
       ORDER BY o.created_at ASC`,
    ).all(p.tenantId, p.userId);
  });

  registerQuery<OrgIdRow | null, OrgTenantSlugParams>(ORG_QUERY_BY_SLUG, (db, p) => {
    return db.prepare<OrgIdRow>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND slug = ? LIMIT 1',
    ).get(p.tenantId, p.slug) ?? null;
  });

  registerQuery<OrgIdRow | null, OrgTenantIdParams>(ORG_QUERY_BY_ID, (db, p) => {
    return db.prepare<OrgIdRow>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.id) ?? null;
  });

  registerQuery<readonly OrgMemberRow[], OrgMembersParams>(ORG_QUERY_MEMBERS, (db, p) => {
    return db.prepare<OrgMemberRow>(
      `SELECT m.id AS membership_id, m.user_id, u.email, m.status, m.created_at
       FROM organization_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? AND m.organization_id = ?
       ORDER BY m.created_at ASC`,
    ).all(p.tenantId, p.organizationId);
  });

  registerQuery<readonly OrgRoleBindingRow[], OrgRoleBindingsParams>(ORG_QUERY_ROLE_BINDINGS, (db, p) => {
    return db.prepare<OrgRoleBindingRow>(
      `SELECT rb.role, rb.workspace_id, w.name AS workspace_name
       FROM organization_role_bindings rb
       LEFT JOIN workspaces w ON w.id = rb.workspace_id
       WHERE rb.tenant_id = ? AND rb.organization_id = ? AND rb.membership_id = ?
       ORDER BY rb.role ASC`,
    ).all(p.tenantId, p.organizationId, p.membershipId);
  });

  registerQuery<OrgUserRow | null, OrgTenantIdParams>(ORG_QUERY_USER_BY_ID, (db, p) => {
    return db.prepare<OrgUserRow>(
      'SELECT id, email FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.id) ?? null;
  });

  registerQuery<OrgUserRow | null, OrgTenantSlugParams>(ORG_QUERY_USER_BY_EMAIL, (db, p) => {
    return db.prepare<OrgUserRow>(
      'SELECT id, email FROM users WHERE tenant_id = ? AND email = ? LIMIT 1',
    ).get(p.tenantId, p.slug) ?? null;
  });

  registerQuery<OrgIdRow | null, OrgWorkspaceByIdParams>(ORG_QUERY_WORKSPACE_BY_ID, (db, p) => {
    return db.prepare<OrgIdRow>(
      'SELECT id FROM workspaces WHERE tenant_id = ? AND organization_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.organizationId, p.workspaceId) ?? null;
  });

  registerQuery<OrgIdRow | null, OrgMembershipParams>(ORG_QUERY_MEMBERSHIP, (db, p) => {
    return db.prepare<OrgIdRow>(
      'SELECT id FROM organization_memberships WHERE tenant_id = ? AND organization_id = ? AND user_id = ? LIMIT 1',
    ).get(p.tenantId, p.organizationId, p.userId) ?? null;
  });

  registerQuery<OrgIdRow | null, OrgRoleBindingExistsParams>(ORG_QUERY_ROLE_BINDING_EXISTS, (db, p) => {
    return db.prepare<OrgIdRow>(
      `SELECT id FROM organization_role_bindings
       WHERE tenant_id = ? AND organization_id = ? AND membership_id = ? AND role = ? AND workspace_id IS NULL
       LIMIT 1`,
    ).get(p.tenantId, p.organizationId, p.membershipId, p.role) ?? null;
  });

  registerQuery<OrgIdRow | null, OrgRoleBindingExistsWsParams>(ORG_QUERY_ROLE_BINDING_EXISTS_WS, (db, p) => {
    return db.prepare<OrgIdRow>(
      `SELECT id FROM organization_role_bindings
       WHERE tenant_id = ? AND organization_id = ? AND membership_id = ? AND role = ? AND workspace_id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.organizationId, p.membershipId, p.role, p.workspaceId) ?? null;
  });

  registerQuery<OrgRow | null, OrgTenantIdParams>(ORG_QUERY_ORG_ROW, (db, p) => {
    return db.prepare<OrgRow>(
      'SELECT * FROM organizations WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.id) ?? null;
  });

  registerQuery<OrgWorkspaceRow | null, OrgTenantIdParams>(ORG_QUERY_WORKSPACE_ROW, (db, p) => {
    return db.prepare<OrgWorkspaceRow>(
      'SELECT * FROM workspaces WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.id) ?? null;
  });

  registerCommand<OrgCreateOrgParams>(ORG_CMD_CREATE_ORG, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO organizations (
        id, tenant_id, name, slug, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.name, p.slug, p.createdByUserId, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<OrgCreateWorkspaceParams>(ORG_CMD_CREATE_WORKSPACE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO workspaces (
        id, tenant_id, organization_id, name, slug, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(p.id, p.tenantId, p.organizationId, p.name, p.slug, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<OrgCreateMembershipParams>(ORG_CMD_CREATE_MEMBERSHIP, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO organization_memberships (
        id, tenant_id, organization_id, user_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(p.id, p.tenantId, p.organizationId, p.userId, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<OrgCreateRoleBindingParams>(ORG_CMD_CREATE_ROLE_BINDING, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO organization_role_bindings (
        id, tenant_id, organization_id, workspace_id, membership_id, role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.organizationId, p.workspaceId, p.membershipId, p.role, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<OrgUpdateMembershipActiveParams>(ORG_CMD_UPDATE_MEMBERSHIP_ACTIVE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE organization_memberships
       SET status = 'active', updated_at = ?
       WHERE tenant_id = ? AND organization_id = ? AND user_id = ?`,
    ).run(p.now, p.tenantId, p.organizationId, p.userId);
    return { rowsAffected: result.changes };
  });
}
