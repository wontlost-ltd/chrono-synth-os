/**
 * Organization Application Service
 * 封装组织、工作区和成员管理的业务逻辑与数据访问
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, OrgListByUserRow, OrgMemberRow, OrgRoleBindingRow } from '@chrono/kernel';
import type { OrganizationRole } from './organization-roles.js';
import {
  orgQueryListByUser, orgQueryBySlug, orgQueryById,
  orgQueryMembers, orgQueryRoleBindings,
  orgQueryUserById, orgQueryUserByEmail,
  orgQueryWorkspaceById, orgQueryMembership,
  orgQueryRoleBindingExists, orgQueryRoleBindingExistsWs,
  orgQueryOrgRow, orgQueryWorkspaceRow,
  orgCmdCreateOrg, orgCmdCreateWorkspace,
  orgCmdCreateMembership, orgCmdCreateRoleBinding,
  orgCmdUpdateMembershipActive,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { asUow, unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { StateError, ValidationError, ErrorCode } from '../errors/index.js';

function slugify(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `org-${randomUUID().slice(0, 8)}`;
}

function serializeOrganization(row: OrgListByUserRow | { id: string; tenant_id: string; name: string; slug: string; created_by_user_id: string; created_at: number; updated_at: number }, workspace?: { id: string; organization_id: string; name: string; slug: string; is_default: number; created_at: number; updated_at: number } | null) {
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

function serializeWorkspace(row: { id: string; organization_id: string; name: string; slug: string; is_default: number; created_at: number; updated_at: number }) {
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
  private readonly tx: SyncWriteUnitOfWork;
  private readonly db: IDatabase | null;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.db = unwrapDb(uowOrDb);
  }

  private runAtomic<T>(fn: () => T): T {
    if (this.db) return this.db.transaction(fn);
    return fn();
  }

  listByUser(tenantId: string, userId: string) {
    const rows = this.tx.queryMany(orgQueryListByUser({ tenantId, userId })) as unknown as OrgListByUserRow[];

    return rows.map((row) => serializeOrganization(row, row.workspace_id ? {
      id: row.workspace_id,
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

    const existingOrg = this.tx.queryOne(orgQueryBySlug({ tenantId, slug: organizationSlug }));
    if (existingOrg) {
      throw new StateError(`organization slug 已存在: ${organizationSlug}`, ErrorCode.STATE_INVALID_TRANSITION);
    }

    this.runAtomic(() => {
      this.tx.execute(orgCmdCreateOrg({ id: organizationId, tenantId, name: input.name, slug: organizationSlug, createdByUserId: userId, now }));
      this.tx.execute(orgCmdCreateWorkspace({ id: workspaceId, tenantId, organizationId, name: input.defaultWorkspaceName, slug: workspaceSlug, now }));
      this.tx.execute(orgCmdCreateMembership({ id: membershipId, tenantId, organizationId, userId, now }));
      this.tx.execute(orgCmdCreateRoleBinding({ id: `orgrole_${randomUUID()}`, tenantId, organizationId, workspaceId: null, membershipId, role: 'org_admin', now }));
    });

    const org = this.tx.queryOne(orgQueryOrgRow({ tenantId, id: organizationId }));
    const workspace = this.tx.queryOne(orgQueryWorkspaceRow({ tenantId, id: workspaceId }));

    return {
      organization: serializeOrganization(org!, workspace),
      membership: this.listMembers(tenantId, organizationId)[0] ?? null,
    };
  }

  listMembers(tenantId: string, organizationId: string) {
    const members = this.tx.queryMany(orgQueryMembers({ tenantId, organizationId })) as unknown as OrgMemberRow[];

    return members.map((member) => {
      const bindings = this.tx.queryMany(orgQueryRoleBindings({ tenantId, organizationId, membershipId: member.membership_id })) as unknown as OrgRoleBindingRow[];

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

    const organization = this.tx.queryOne(orgQueryById({ tenantId, id: organizationId }));
    if (!organization) {
      throw new ValidationError(`organization 不存在: ${organizationId}`, ErrorCode.NOT_FOUND_PERSONA);
    }

    let user = input.userId
      ? this.tx.queryOne(orgQueryUserById({ tenantId, id: input.userId }))
      : undefined;
    if (!user && input.email) {
      user = this.tx.queryOne(orgQueryUserByEmail({ tenantId, slug: input.email }));
    }
    if (!user) {
      throw new ValidationError('目标用户不存在或不属于当前 tenant', ErrorCode.VALIDATION_REQUIRED);
    }

    let workspaceId: string | null = null;
    if (input.workspaceId) {
      const workspace = this.tx.queryOne(orgQueryWorkspaceById({ tenantId, organizationId, workspaceId: input.workspaceId }));
      if (!workspace) {
        throw new ValidationError('workspace 不存在或不属于该 organization', ErrorCode.VALIDATION_REQUIRED);
      }
      workspaceId = workspace.id;
    }

    const existingMembership = this.tx.queryOne(orgQueryMembership({ tenantId, organizationId, userId: user.id }));
    const membershipId = existingMembership?.id ?? `orgm_${randomUUID()}`;

    this.runAtomic(() => {
      if (existingMembership) {
        this.tx.execute(orgCmdUpdateMembershipActive({ tenantId, organizationId, userId: user!.id, now }));
      } else {
        this.tx.execute(orgCmdCreateMembership({ id: membershipId, tenantId, organizationId, userId: user!.id, now }));
      }

      const resolvedMembership = this.tx.queryOne(orgQueryMembership({ tenantId, organizationId, userId: user!.id }));
      if (!resolvedMembership) {
        throw new StateError('organization membership upsert 失败', ErrorCode.STATE_INVALID_TRANSITION);
      }

      for (const role of input.roles) {
        if (this.hasRoleBinding(tenantId, organizationId, resolvedMembership.id, role, workspaceId)) {
          continue;
        }
        this.tx.execute(orgCmdCreateRoleBinding({ id: `orgrole_${randomUUID()}`, tenantId, organizationId, workspaceId, membershipId: resolvedMembership.id, role, now }));
      }
    });

    return this.listMembers(tenantId, organizationId)
      .find((item) => item.userId === user!.id) ?? null;
  }

  private hasRoleBinding(
    tenantId: string,
    organizationId: string,
    membershipId: string,
    role: OrganizationRole,
    workspaceId: string | null,
  ): boolean {
    const existing = workspaceId === null
      ? this.tx.queryOne(orgQueryRoleBindingExists({ tenantId, organizationId, membershipId, role }))
      : this.tx.queryOne(orgQueryRoleBindingExistsWs({ tenantId, organizationId, membershipId, role, workspaceId }));
    return Boolean(existing);
  }
}
