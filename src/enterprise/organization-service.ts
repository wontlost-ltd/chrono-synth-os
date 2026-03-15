/**
 * Organization Application Service
 * 封装组织、工作区和成员管理的业务逻辑与数据访问
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { OrganizationRole } from './organization-roles.js';
import { StateError, ValidationError, ErrorCode } from '../errors/index.js';

interface OrganizationRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
}

interface WorkspaceRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  slug: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

function slugify(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `org-${randomUUID().slice(0, 8)}`;
}

function serializeOrganization(row: OrganizationRow, workspace?: WorkspaceRow | null) {
  return {
    organizationId: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    defaultWorkspace: workspace ? serializeWorkspace(workspace) : null,
  };
}

function serializeWorkspace(row: WorkspaceRow) {
  return {
    workspaceId: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    isDefault: Boolean(row.is_default),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  defaultWorkspaceName: string;
  defaultWorkspaceSlug?: string;
}

export interface UpsertMemberInput {
  userId?: string;
  email?: string;
  roles: OrganizationRole[];
  workspaceId?: string;
}

export class OrganizationService {
  constructor(private readonly db: IDatabase) {}

  listByUser(tenantId: string, userId: string) {
    const rows = this.db.prepare<OrganizationRow & {
      workspace_id: string | null;
      workspace_name: string | null;
      workspace_slug: string | null;
      workspace_is_default: number | null;
      workspace_created_at: number | null;
      workspace_updated_at: number | null;
    }>(
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
    ).all(tenantId, userId);

    return rows.map((row) => serializeOrganization(row, row.workspace_id ? {
      id: row.workspace_id,
      tenant_id: row.tenant_id,
      organization_id: row.id,
      name: row.workspace_name ?? 'Default Workspace',
      slug: row.workspace_slug ?? 'default',
      is_default: row.workspace_is_default ?? 1,
      created_at: row.workspace_created_at ?? row.created_at,
      updated_at: row.workspace_updated_at ?? row.updated_at,
    } : null));
  }

  create(tenantId: string, userId: string, input: CreateOrganizationInput) {
    const now = Date.now();
    const organizationId = `org_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    const membershipId = `orgm_${randomUUID()}`;
    const organizationSlug = input.slug ?? slugify(input.name);
    const workspaceSlug = input.defaultWorkspaceSlug ?? slugify(input.defaultWorkspaceName);

    const existingOrg = this.db.prepare<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND slug = ? LIMIT 1',
    ).get(tenantId, organizationSlug);
    if (existingOrg) {
      throw new StateError(`organization slug 已存在: ${organizationSlug}`, ErrorCode.STATE_INVALID_TRANSITION);
    }

    this.db.transaction(() => {
      this.db.prepare<void>(
        `INSERT INTO organizations (
          id, tenant_id, name, slug, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(organizationId, tenantId, input.name, organizationSlug, userId, now, now);

      this.db.prepare<void>(
        `INSERT INTO workspaces (
          id, tenant_id, organization_id, name, slug, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(workspaceId, tenantId, organizationId, input.defaultWorkspaceName, workspaceSlug, now, now);

      this.db.prepare<void>(
        `INSERT INTO organization_memberships (
          id, tenant_id, organization_id, user_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(membershipId, tenantId, organizationId, userId, now, now);

      this.db.prepare<void>(
        `INSERT INTO organization_role_bindings (
          id, tenant_id, organization_id, workspace_id, membership_id, role, created_at
        ) VALUES (?, ?, ?, NULL, ?, 'org_admin', ?)`,
      ).run(`orgrole_${randomUUID()}`, tenantId, organizationId, membershipId, now);
    });

    const org = this.db.prepare<OrganizationRow>(
      'SELECT * FROM organizations WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(tenantId, organizationId);
    const workspace = this.db.prepare<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(tenantId, workspaceId);

    return {
      organization: serializeOrganization(org!, workspace),
      membership: this.listMembers(tenantId, organizationId)[0] ?? null,
    };
  }

  listMembers(tenantId: string, organizationId: string) {
    const members = this.db.prepare<{
      membership_id: string;
      user_id: string;
      email: string;
      status: string;
      created_at: number;
    }>(
      `SELECT m.id AS membership_id, m.user_id, u.email, m.status, m.created_at
       FROM organization_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? AND m.organization_id = ?
       ORDER BY m.created_at ASC`,
    ).all(tenantId, organizationId);

    return members.map((member) => {
      const bindings = this.db.prepare<{
        role: OrganizationRole;
        workspace_id: string | null;
        workspace_name: string | null;
      }>(
        `SELECT rb.role, rb.workspace_id, w.name AS workspace_name
         FROM organization_role_bindings rb
         LEFT JOIN workspaces w ON w.id = rb.workspace_id
         WHERE rb.tenant_id = ? AND rb.organization_id = ? AND rb.membership_id = ?
         ORDER BY rb.role ASC`,
      ).all(tenantId, organizationId, member.membership_id);

      return {
        membershipId: member.membership_id,
        userId: member.user_id,
        email: member.email,
        status: member.status,
        roles: [...new Set(bindings.map((b) => b.role))],
        bindings: bindings.map((b) => ({
          role: b.role,
          workspaceId: b.workspace_id,
          workspaceName: b.workspace_name,
        })),
        joinedAt: new Date(Number(member.created_at)).toISOString(),
      };
    });
  }

  upsertMember(tenantId: string, organizationId: string, input: UpsertMemberInput) {
    const now = Date.now();

    const organization = this.db.prepare<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(tenantId, organizationId);
    if (!organization) {
      throw new ValidationError(`organization 不存在: ${organizationId}`, ErrorCode.NOT_FOUND_PERSONA);
    }

    let user = input.userId
      ? this.db.prepare<{ id: string; email: string }>(
        'SELECT id, email FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
      ).get(tenantId, input.userId)
      : undefined;
    if (!user && input.email) {
      user = this.db.prepare<{ id: string; email: string }>(
        'SELECT id, email FROM users WHERE tenant_id = ? AND email = ? LIMIT 1',
      ).get(tenantId, input.email);
    }
    if (!user) {
      throw new ValidationError('目标用户不存在或不属于当前 tenant', ErrorCode.VALIDATION_REQUIRED);
    }

    let workspaceId: string | null = null;
    if (input.workspaceId) {
      const workspace = this.db.prepare<{ id: string }>(
        'SELECT id FROM workspaces WHERE tenant_id = ? AND organization_id = ? AND id = ? LIMIT 1',
      ).get(tenantId, organizationId, input.workspaceId);
      if (!workspace) {
        throw new ValidationError('workspace 不存在或不属于该 organization', ErrorCode.VALIDATION_REQUIRED);
      }
      workspaceId = workspace.id;
    }

    const existingMembership = this.db.prepare<{ id: string }>(
      'SELECT id FROM organization_memberships WHERE tenant_id = ? AND organization_id = ? AND user_id = ? LIMIT 1',
    ).get(tenantId, organizationId, user.id);
    const membershipId = existingMembership?.id ?? `orgm_${randomUUID()}`;

    this.db.transaction(() => {
      if (existingMembership) {
        this.db.prepare<void>(
          `UPDATE organization_memberships
           SET status = 'active', updated_at = ?
           WHERE tenant_id = ? AND organization_id = ? AND user_id = ?`,
        ).run(now, tenantId, organizationId, user.id);
      } else {
        this.db.prepare<void>(
          `INSERT INTO organization_memberships (
            id, tenant_id, organization_id, user_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        ).run(membershipId, tenantId, organizationId, user.id, now, now);
      }

      const resolvedMembershipId = this.db.prepare<{ id: string }>(
        'SELECT id FROM organization_memberships WHERE tenant_id = ? AND organization_id = ? AND user_id = ? LIMIT 1',
      ).get(tenantId, organizationId, user.id)?.id;
      if (!resolvedMembershipId) {
        throw new StateError('organization membership upsert 失败', ErrorCode.STATE_INVALID_TRANSITION);
      }

      for (const role of input.roles) {
        if (this.hasRoleBinding(tenantId, organizationId, resolvedMembershipId, role, workspaceId)) {
          continue;
        }
        this.db.prepare<void>(
          `INSERT INTO organization_role_bindings (
            id, tenant_id, organization_id, workspace_id, membership_id, role, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(`orgrole_${randomUUID()}`, tenantId, organizationId, workspaceId, resolvedMembershipId, role, now);
      }
    });

    return this.listMembers(tenantId, organizationId)
      .find((item) => item.userId === user.id) ?? null;
  }

  private hasRoleBinding(
    tenantId: string,
    organizationId: string,
    membershipId: string,
    role: OrganizationRole,
    workspaceId: string | null,
  ): boolean {
    const existing = workspaceId === null
      ? this.db.prepare<{ id: string }>(
        `SELECT id FROM organization_role_bindings
         WHERE tenant_id = ? AND organization_id = ? AND membership_id = ? AND role = ? AND workspace_id IS NULL
         LIMIT 1`,
      ).get(tenantId, organizationId, membershipId, role)
      : this.db.prepare<{ id: string }>(
        `SELECT id FROM organization_role_bindings
         WHERE tenant_id = ? AND organization_id = ? AND membership_id = ? AND role = ? AND workspace_id = ?
         LIMIT 1`,
      ).get(tenantId, organizationId, membershipId, role, workspaceId);
    return Boolean(existing);
  }
}
