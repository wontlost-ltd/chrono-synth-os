import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import {
  orgQueryActiveMembership, orgQueryMembershipRoles,
} from '@chrono/kernel';
import type { IDatabase } from '../../storage/database.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
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
  const tx = directUnitOfWork(db);

  const membership = tx.queryOne(orgQueryActiveMembership({ tenantId, organizationId, userId }));
  if (!membership) return null;

  const roleRows = tx.queryMany(orgQueryMembershipRoles({
    tenantId, organizationId, membershipId: membership.membership_id,
  })) as unknown as Array<{ role: OrganizationRole }>;

  return {
    membershipId: membership.membership_id,
    organizationId: membership.organization_id,
    userId: membership.user_id,
    roles: roleRows.map((row) => row.role),
  };
}

export function requireOrganizationRole(
  db: IDatabase,
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
