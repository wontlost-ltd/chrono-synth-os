import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import {
  orgQueryActiveMembership, orgQueryMembershipRoles,
} from '@chrono/kernel';
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, ErrorCode } from '../../errors/index.js';
import { ORGANIZATION_ROLES, type OrganizationRole } from '../../enterprise/organization-roles.js';

export { ORGANIZATION_ROLES, type OrganizationRole };

export interface OrganizationMembershipContext {
  membershipId: string;
  organizationId: string;
  userId: string;
  roles: OrganizationRole[];
}

declare module 'fastify' {
  interface FastifyRequest {
    organizationMembership?: OrganizationMembershipContext;
  }
}

export function getOrganizationMembershipContext(
  db: IDatabase,
  tenantId: string,
  organizationId: string,
  userId: string,
): OrganizationMembershipContext | null {
  registerCoreSelfExecutors();
  const tx = db;

  const membership = tx.queryOne(orgQueryActiveMembership({ tenantId, organizationId, userId }));
  if (!membership) return null;

  const roleRows = tx.queryMany(orgQueryMembershipRoles({
    tenantId, organizationId, membershipId: membership.membership_id,
  })).map((r) => ({ role: r.role as OrganizationRole }));

  return {
    membershipId: membership.membership_id,
    organizationId: membership.organization_id,
    userId: membership.user_id,
    roles: roleRows.map((row) => row.role),
  };
}

export function requireOrganizationRole(
  /**
   * 分片 Phase 0 · Plan 1b（Task 9）：改收共享 `TenantDbResolver`（非固定 host db）。
   * membership 校验在**请求内**经 `resolver.dbForTenant(request.tenantId)` 解析该租户所在 shard，
   * 多库下不同租户命中不同物理 db；单库下三方法返回同一 db，行为等价现状（零回归）。
   */
  resolver: TenantDbResolver,
  resolveOrganizationId: (request: FastifyRequest) => string,
  ...allowedRoles: OrganizationRole[]
): preHandlerHookHandler {
  const allowed = new Set<OrganizationRole>(allowedRoles);
  return (request: FastifyRequest, _reply: FastifyReply, done) => {
    const user = request.user as JwtPayload | undefined;
    if (!user || user.sub.startsWith('apikey:')) {
      done(new AuthorizationError('此端点仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE));
      return;
    }

    const organizationId = resolveOrganizationId(request);
    /* 按请求租户选 shard：request.tenantId 由 tenant 插件从 JWT 解析（不可伪造）。 */
    const db = resolver.dbForTenant(request.tenantId);
    const context = getOrganizationMembershipContext(db, request.tenantId, organizationId, user.sub);
    if (!context) {
      done(new AuthorizationError('无权访问该 organization', ErrorCode.AUTH_INSUFFICIENT_ROLE));
      return;
    }
    if (allowed.size > 0 && !context.roles.some((role) => allowed.has(role))) {
      done(new AuthorizationError('organization 角色权限不足', ErrorCode.AUTH_INSUFFICIENT_ROLE));
      return;
    }

    request.organizationMembership = context;
    done();
  };
}
