import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import { PaginationQuerySchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';

function parsePagination(query: unknown) {
  const parsed = PaginationQuerySchema.parse(query ?? {});
  return { page: parsed.page, pageSize: parsed.pageSize };
}

export function registerAdminControlPlaneRoutes(app: FastifyInstance, services: AppServices): void {
  const { adminControlPlane: service } = services;

  app.get('/api/v1/admin/personas', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const query = request.query as { page?: string; pageSize?: string; status?: string };
    const pagination = parsePagination(query);
    const status = query.status?.trim();
    return service.listPersonas(request.tenantId, pagination, status);
  });

  app.get('/api/v1/admin/tasks', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const query = request.query as { page?: string; pageSize?: string; status?: string };
    const pagination = parsePagination(query);
    const status = query.status?.trim();
    return service.listTasks(request.tenantId, pagination, status);
  });

  app.get('/api/v1/admin/wallets', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const query = request.query as { page?: string; pageSize?: string; status?: string };
    const pagination = parsePagination(query);
    const status = query.status?.trim();
    return service.listWallets(request.tenantId, pagination, status);
  });

  app.get('/api/v1/admin/governance', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const query = request.query as { page?: string; pageSize?: string; status?: string };
    const pagination = parsePagination(query);
    const status = query.status?.trim();
    return service.listGovernanceCases(request.tenantId, pagination, status);
  });
}
