/**
 * Organization Application Service
 * 封装组织、工作区和成员管理的业务逻辑与数据访问
 *
 * 分片 Phase 0 · Plan 1b（Task 5）：
 * - organizations/workspaces/organization_memberships/organization_role_bindings 全**有 tenant_id 列**，
 *   故租户约束直接在 query/executor 层 `WHERE tenant_id=? AND …`（本 Task 前 executor 已全含 predicate）。
 * - public 方法**已普遍带 tenantId**（listByUser/create/listMembers/upsertMember），本 Task 仅
 *   ctor `(tx)`→`(resolver)` + 每方法 `const tx = this.txFor(tenantId)`（dbForTenant 选对 shard）。
 * - 双重约束：`dbForTenant(tenantId)` 选对 shard + SQL tenant predicate 防同库跨租户读改删。
 * - organizations 不被 mixed-scope coordinator 复用（不同于 IdentityWriter），故不抽 writer seam，
 *   照 MobileDeviceService/CollaborationService 直取 tx。
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, OrgListByUserRow } from '@chrono/kernel';
import type { OrganizationRole } from './organization-roles.js';
import {
  orgQueryListByUser, orgQueryBySlug, orgQueryById,
  orgQueryMembers, orgQueryRoleBindingsByOrg,
  orgQueryUserById, orgQueryUserByEmail,
  orgQueryWorkspaceById, orgQueryMembership,
  orgQueryRoleBindingExists, orgQueryRoleBindingExistsWs,
  orgQueryOrgRow, orgQueryWorkspaceRow,
  orgCmdCreateOrg, orgCmdCreateWorkspace,
  orgCmdCreateMembership, orgCmdCreateRoleBinding,
  orgCmdUpdateMembershipActive,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
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
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现取该租户 shard 的 tx（dbForTenant 选 shard），不跨请求缓存。 */
  private txFor(tenantId: string): SyncWriteUnitOfWork {
    return this.resolver.dbForTenant(tenantId);
  }

  listByUser(tenantId: string, userId: string) {
    const tx = this.txFor(tenantId);
    const rows = tx.queryMany(orgQueryListByUser({ tenantId, userId }));

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
    const tx = this.txFor(tenantId);
    const now = Date.now();
    const organizationId = `org_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    const membershipId = `orgm_${randomUUID()}`;
    const organizationSlug = input.slug ?? slugify(input.name);
    const workspaceSlug = input.defaultWorkspaceSlug ?? slugify(input.defaultWorkspaceName);

    const existingOrg = tx.queryOne(orgQueryBySlug({ tenantId, slug: organizationSlug }));
    if (existingOrg) {
      throw new StateError(`organization slug 已存在: ${organizationSlug}`, ErrorCode.STATE_INVALID_TRANSITION);
    }

    tx.transaction(() => {
      tx.execute(orgCmdCreateOrg({ id: organizationId, tenantId, name: input.name, slug: organizationSlug, createdByUserId: userId, now }));
      tx.execute(orgCmdCreateWorkspace({ id: workspaceId, tenantId, organizationId, name: input.defaultWorkspaceName, slug: workspaceSlug, now }));
      tx.execute(orgCmdCreateMembership({ id: membershipId, tenantId, organizationId, userId, now }));
      tx.execute(orgCmdCreateRoleBinding({ id: `orgrole_${randomUUID()}`, tenantId, organizationId, workspaceId: null, membershipId, role: 'org_admin', now }));
    });

    const org = tx.queryOne(orgQueryOrgRow({ tenantId, id: organizationId }));
    const workspace = tx.queryOne(orgQueryWorkspaceRow({ tenantId, id: workspaceId }));

    return {
      organization: serializeOrganization(org!, workspace),
      membership: this.listMembers(tenantId, organizationId)[0] ?? null,
    };
  }

  listMembers(tenantId: string, organizationId: string) {
    const tx = this.txFor(tenantId);
    const members = tx.queryMany(orgQueryMembers({ tenantId, organizationId }));

    /*
     * 消 N+1（P2-a/P2-e）：一次批量取整组织全部成员的角色绑定，按 membership_id 内存分组，
     * 替代「每成员一次 orgQueryRoleBindings」。大组织（500+ 成员）从 1+N 次查询降为 2 次。
     */
    const allBindings = tx.queryMany(orgQueryRoleBindingsByOrg({ tenantId, organizationId }));
    const bindingsByMembership = new Map<string, Array<typeof allBindings[number]>>();
    for (const b of allBindings) {
      const list = bindingsByMembership.get(b.membership_id);
      if (list) list.push(b);
      else bindingsByMembership.set(b.membership_id, [b]);
    }

    return members.map((member) => {
      const bindings = bindingsByMembership.get(member.membership_id) ?? [];

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
    const tx = this.txFor(tenantId);
    const now = Date.now();

    const organization = tx.queryOne(orgQueryById({ tenantId, id: organizationId }));
    if (!organization) {
      throw new ValidationError(`organization 不存在: ${organizationId}`, ErrorCode.NOT_FOUND_PERSONA);
    }

    let user = input.userId
      ? tx.queryOne(orgQueryUserById({ tenantId, id: input.userId }))
      : undefined;
    if (!user && input.email) {
      user = tx.queryOne(orgQueryUserByEmail({ tenantId, slug: input.email }));
    }
    if (!user) {
      throw new ValidationError('目标用户不存在或不属于当前 tenant', ErrorCode.VALIDATION_REQUIRED);
    }

    let workspaceId: string | null = null;
    if (input.workspaceId) {
      const workspace = tx.queryOne(orgQueryWorkspaceById({ tenantId, organizationId, workspaceId: input.workspaceId }));
      if (!workspace) {
        throw new ValidationError('workspace 不存在或不属于该 organization', ErrorCode.VALIDATION_REQUIRED);
      }
      workspaceId = workspace.id;
    }

    const existingMembership = tx.queryOne(orgQueryMembership({ tenantId, organizationId, userId: user.id }));
    const membershipId = existingMembership?.id ?? `orgm_${randomUUID()}`;

    tx.transaction(() => {
      if (existingMembership) {
        tx.execute(orgCmdUpdateMembershipActive({ tenantId, organizationId, userId: user!.id, now }));
      } else {
        tx.execute(orgCmdCreateMembership({ id: membershipId, tenantId, organizationId, userId: user!.id, now }));
      }

      const resolvedMembership = tx.queryOne(orgQueryMembership({ tenantId, organizationId, userId: user!.id }));
      if (!resolvedMembership) {
        throw new StateError('organization membership upsert 失败', ErrorCode.STATE_INVALID_TRANSITION);
      }

      for (const role of input.roles) {
        if (this.hasRoleBinding(tx, tenantId, organizationId, resolvedMembership.id, role, workspaceId)) {
          continue;
        }
        tx.execute(orgCmdCreateRoleBinding({ id: `orgrole_${randomUUID()}`, tenantId, organizationId, workspaceId, membershipId: resolvedMembership.id, role, now }));
      }
    });

    return this.listMembers(tenantId, organizationId)
      .find((item) => item.userId === user!.id) ?? null;
  }

  private hasRoleBinding(
    tx: SyncWriteUnitOfWork,
    tenantId: string,
    organizationId: string,
    membershipId: string,
    role: OrganizationRole,
    workspaceId: string | null,
  ): boolean {
    const existing = workspaceId === null
      ? tx.queryOne(orgQueryRoleBindingExists({ tenantId, organizationId, membershipId, role }))
      : tx.queryOne(orgQueryRoleBindingExistsWs({ tenantId, organizationId, membershipId, role, workspaceId }));
    return Boolean(existing);
  }
}
