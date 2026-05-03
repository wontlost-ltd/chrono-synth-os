import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import { AuthenticationError, ErrorCode, ValidationError } from '../../errors/index.js';
import { ScimCreateUserSchema } from '../schemas/api-schemas.js';

function getScimBearerToken(headers: { authorization?: string }): string {
  const value = headers.authorization;
  if (!value?.startsWith('Bearer ')) {
    throw new AuthenticationError('SCIM Bearer token 缺失', ErrorCode.AUTH_INVALID_TOKEN);
  }
  return value.slice('Bearer '.length).trim();
}

function parseScimFilter(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(raw.trim());
  return match?.[1];
}

export function registerScimRoutes(app: FastifyInstance, services: AppServices): void {
  const { tenantProfile: profileService, scim: scimService } = services;

  async function resolveTenantId(authHeader: string | undefined): Promise<string> {
    const token = getScimBearerToken({ authorization: authHeader });
    const principal = profileService.resolveScimTenant(token);
    if (!principal) {
      throw new AuthenticationError('SCIM token 无效', ErrorCode.AUTH_INVALID_TOKEN);
    }
    return principal.tenantId;
  }

  app.get('/scim/v2/Users', async (request) => {
    const tenantId = await resolveTenantId(request.headers.authorization);
    const query = request.query as { filter?: string; startIndex?: string; count?: string };
    const userName = parseScimFilter(query.filter);
    const startIndex = Math.max(parseInt(query.startIndex ?? '1', 10) || 1, 1);
    const count = Math.min(Math.max(parseInt(query.count ?? '100', 10) || 100, 1), 100);
    return scimService.listUsers(tenantId, { userName, startIndex, count });
  });

  app.post('/scim/v2/Users', async (request, reply) => {
    const tenantId = await resolveTenantId(request.headers.authorization);
    const payload = ScimCreateUserSchema.parse(request.body);
    const email = payload.userName || payload.emails?.find((item) => item.primary)?.value || payload.emails?.[0]?.value;
    if (!email) {
      throw new ValidationError('SCIM userName/email 缺失', ErrorCode.VALIDATION_REQUIRED);
    }
    if (!payload.active) {
      throw new ValidationError('当前 SCIM 实现仅接受 active=true 的用户创建', ErrorCode.VALIDATION_FORMAT);
    }

    const displayName = payload.name?.formatted || email.split('@')[0];
    const result = scimService.createUser(tenantId, { email, displayName });
    return reply.status(result.isNew ? 201 : 200).send(result.user);
  });

  app.delete<{ Params: { id: string } }>('/scim/v2/Users/:id', async (request, reply) => {
    const tenantId = await resolveTenantId(request.headers.authorization);
    const found = scimService.deleteUser(tenantId, request.params.id);
    if (!found) {
      return reply.status(404).send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '404',
        detail: 'User not found',
      });
    }
    return reply.status(204).send();
  });
}
