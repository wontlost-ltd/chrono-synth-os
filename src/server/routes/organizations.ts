import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, ErrorCode } from '../../errors/index.js';
import { requireOrganizationRole } from '../plugins/organization-rbac.js';
import { CreateOrganizationSchema, UpsertOrganizationMemberSchema } from '../schemas/api-schemas.js';

function requireJwtUser(request: { user?: JwtPayload }): JwtPayload {
  const user = request.user;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError('此端点仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE);
  }
  return user;
}

export function registerOrganizationRoutes(app: FastifyInstance, services: AppServices): void {
  const { db, organization: service } = services;

  app.get('/api/v1/organizations', async (request) => {
    const user = requireJwtUser(request);
    return { data: service.listByUser(request.tenantId, user.sub) };
  });

  app.post('/api/v1/organizations', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = CreateOrganizationSchema.parse(request.body);
    const result = service.create(request.tenantId, user.sub, {
      name: body.name,
      slug: body.slug,
      defaultWorkspaceName: body.defaultWorkspaceName,
      defaultWorkspaceSlug: body.defaultWorkspaceSlug,
    });
    return reply.status(201).send({ data: result });
  });

  app.get<{ Params: { id: string } }>('/api/v1/organizations/:id/members', {
    preHandler: requireOrganizationRole(db, (request) => (request.params as { id: string }).id),
  }, async (request) => {
    return { data: service.listMembers(request.tenantId, request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/organizations/:id/members', {
    preHandler: requireOrganizationRole(db, (request) => (request.params as { id: string }).id, 'org_admin'),
  }, async (request, reply) => {
    const body = UpsertOrganizationMemberSchema.parse(request.body);
    const member = service.upsertMember(request.tenantId, request.params.id, {
      userId: body.userId,
      email: body.email,
      roles: body.roles,
      workspaceId: body.workspaceId,
    });
    return reply.send({ data: member });
  });
}
