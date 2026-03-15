import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, StateError, ValidationError, ErrorCode } from '../../errors/index.js';
import {
  type OrganizationRole,
  requireOrganizationRole,
} from '../plugins/organization-rbac.js';
import { CreateOrganizationSchema, UpsertOrganizationMemberSchema } from '../schemas/api-schemas.js';

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

function requireJwtUser(request: { user?: JwtPayload }): JwtPayload {
  const user = request.user;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError('此端点仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE);
  }
  return user;
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

function listMemberSummaries(db: IDatabase, tenantId: string, organizationId: string) {
  const members = db.prepare<{
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
    const bindings = db.prepare<{
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
      roles: [...new Set(bindings.map((binding) => binding.role))],
      bindings: bindings.map((binding) => ({
        role: binding.role,
        workspaceId: binding.workspace_id,
        workspaceName: binding.workspace_name,
      })),
      joinedAt: new Date(Number(member.created_at)).toISOString(),
    };
  });
}

function hasRoleBinding(
  db: IDatabase,
  tenantId: string,
  organizationId: string,
  membershipId: string,
  role: OrganizationRole,
  workspaceId: string | null,
): boolean {
  const existing = workspaceId === null
    ? db.prepare<{ id: string }>(
      `SELECT id
       FROM organization_role_bindings
       WHERE tenant_id = ?
         AND organization_id = ?
         AND membership_id = ?
         AND role = ?
         AND workspace_id IS NULL
       LIMIT 1`,
    ).get(tenantId, organizationId, membershipId, role)
    : db.prepare<{ id: string }>(
      `SELECT id
       FROM organization_role_bindings
       WHERE tenant_id = ?
         AND organization_id = ?
         AND membership_id = ?
         AND role = ?
         AND workspace_id = ?
       LIMIT 1`,
    ).get(tenantId, organizationId, membershipId, role, workspaceId);
  return Boolean(existing);
}

export function registerOrganizationRoutes(app: FastifyInstance, db: IDatabase): void {
  app.get('/api/v1/organizations', async (request) => {
    const user = requireJwtUser(request);
    const rows = db.prepare<OrganizationRow & {
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
    ).all(request.tenantId, user.sub);

    return {
      data: rows.map((row) => serializeOrganization(row, row.workspace_id ? {
        id: row.workspace_id,
        tenant_id: row.tenant_id,
        organization_id: row.id,
        name: row.workspace_name ?? 'Default Workspace',
        slug: row.workspace_slug ?? 'default',
        is_default: row.workspace_is_default ?? 1,
        created_at: row.workspace_created_at ?? row.created_at,
        updated_at: row.workspace_updated_at ?? row.updated_at,
      } : null)),
    };
  });

  app.post('/api/v1/organizations', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = CreateOrganizationSchema.parse(request.body);
    const now = Date.now();
    const organizationId = `org_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    const membershipId = `orgm_${randomUUID()}`;
    const organizationSlug = body.slug ?? slugify(body.name);
    const workspaceSlug = body.defaultWorkspaceSlug ?? slugify(body.defaultWorkspaceName);

    const existingOrg = db.prepare<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND slug = ? LIMIT 1',
    ).get(request.tenantId, organizationSlug);
    if (existingOrg) {
      throw new StateError(`organization slug 已存在: ${organizationSlug}`, ErrorCode.STATE_INVALID_TRANSITION);
    }

    db.transaction(() => {
      db.prepare<void>(
        `INSERT INTO organizations (
          id, tenant_id, name, slug, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(organizationId, request.tenantId, body.name, organizationSlug, user.sub, now, now);

      db.prepare<void>(
        `INSERT INTO workspaces (
          id, tenant_id, organization_id, name, slug, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(workspaceId, request.tenantId, organizationId, body.defaultWorkspaceName, workspaceSlug, now, now);

      db.prepare<void>(
        `INSERT INTO organization_memberships (
          id, tenant_id, organization_id, user_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(membershipId, request.tenantId, organizationId, user.sub, now, now);

      db.prepare<void>(
        `INSERT INTO organization_role_bindings (
          id, tenant_id, organization_id, workspace_id, membership_id, role, created_at
        ) VALUES (?, ?, ?, NULL, ?, 'org_admin', ?)`,
      ).run(`orgrole_${randomUUID()}`, request.tenantId, organizationId, membershipId, now);
    });

    const org = db.prepare<OrganizationRow>(
      'SELECT * FROM organizations WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(request.tenantId, organizationId);
    const workspace = db.prepare<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(request.tenantId, workspaceId);

    return reply.status(201).send({
      data: {
        organization: serializeOrganization(org!, workspace),
        membership: listMemberSummaries(db, request.tenantId, organizationId)[0] ?? null,
      },
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/organizations/:id/members', {
    preHandler: requireOrganizationRole(db, (request) => (request.params as { id: string }).id),
  }, async (request) => {
    return {
      data: listMemberSummaries(db, request.tenantId, request.params.id),
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/organizations/:id/members', {
    preHandler: requireOrganizationRole(db, (request) => (request.params as { id: string }).id, 'org_admin'),
  }, async (request, reply) => {
    const body = UpsertOrganizationMemberSchema.parse(request.body);
    const organizationId = request.params.id;
    const now = Date.now();

    const organization = db.prepare<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(request.tenantId, organizationId);
    if (!organization) {
      throw new ValidationError(`organization 不存在: ${organizationId}`, ErrorCode.NOT_FOUND_PERSONA);
    }

    let user = body.userId
      ? db.prepare<{ id: string; email: string }>(
        'SELECT id, email FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
      ).get(request.tenantId, body.userId)
      : undefined;
    if (!user && body.email) {
      user = db.prepare<{ id: string; email: string }>(
        'SELECT id, email FROM users WHERE tenant_id = ? AND email = ? LIMIT 1',
      ).get(request.tenantId, body.email);
    }
    if (!user) {
      throw new ValidationError('目标用户不存在或不属于当前 tenant', ErrorCode.VALIDATION_REQUIRED);
    }

    let workspaceId: string | null = null;
    if (body.workspaceId) {
      const workspace = db.prepare<{ id: string }>(
        'SELECT id FROM workspaces WHERE tenant_id = ? AND organization_id = ? AND id = ? LIMIT 1',
      ).get(request.tenantId, organizationId, body.workspaceId);
      if (!workspace) {
        throw new ValidationError('workspace 不存在或不属于该 organization', ErrorCode.VALIDATION_REQUIRED);
      }
      workspaceId = workspace.id;
    }

    const existingMembership = db.prepare<{ id: string }>(
      'SELECT id FROM organization_memberships WHERE tenant_id = ? AND organization_id = ? AND user_id = ? LIMIT 1',
    ).get(request.tenantId, organizationId, user.id);
    const membershipId = existingMembership?.id ?? `orgm_${randomUUID()}`;

    db.transaction(() => {
      if (existingMembership) {
        db.prepare<void>(
          `UPDATE organization_memberships
           SET status = 'active', updated_at = ?
           WHERE tenant_id = ? AND organization_id = ? AND user_id = ?`,
        ).run(now, request.tenantId, organizationId, user.id);
      } else {
        db.prepare<void>(
          `INSERT INTO organization_memberships (
            id, tenant_id, organization_id, user_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        ).run(membershipId, request.tenantId, organizationId, user.id, now, now);
      }

      const resolvedMembershipId = db.prepare<{ id: string }>(
        'SELECT id FROM organization_memberships WHERE tenant_id = ? AND organization_id = ? AND user_id = ? LIMIT 1',
      ).get(request.tenantId, organizationId, user.id)?.id;
      if (!resolvedMembershipId) {
        throw new StateError('organization membership upsert 失败', ErrorCode.STATE_INVALID_TRANSITION);
      }

      for (const role of body.roles) {
        if (hasRoleBinding(db, request.tenantId, organizationId, resolvedMembershipId, role, workspaceId)) {
          continue;
        }
        db.prepare<void>(
          `INSERT INTO organization_role_bindings (
            id, tenant_id, organization_id, workspace_id, membership_id, role, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(`orgrole_${randomUUID()}`, request.tenantId, organizationId, workspaceId, resolvedMembershipId, role, now);
      }
    });

    const member = listMemberSummaries(db, request.tenantId, organizationId)
      .find((item) => item.userId === user.id) ?? null;
    return reply.send({ data: member });
  });
}
