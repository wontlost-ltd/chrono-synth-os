/**
 * 移动端设备管理路由
 * 路由层只做请求解析和响应序列化，业务逻辑委托 MobileDeviceFacade
 */

import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../app-services.js';
import type { JwtPayload } from '../../types/auth.js';
import { RegisterDeviceSchema, UpdatePushTokenSchema, InstallAvatarSchema } from '../schemas/api-schemas.js';

export function registerMobileRoutes(app: FastifyInstance, services: AppServices): void {
  const { mobileDeviceFacade: facade } = services;

  app.post('/api/v1/devices', async (request) => {
    const user = request.user as JwtPayload;
    const body = RegisterDeviceSchema.parse(request.body);
    return { data: facade.register(user, body) };
  });

  app.get('/api/v1/devices', async (request) => {
    return { data: facade.listDevices(request.user as JwtPayload) };
  });

  app.patch('/api/v1/devices/:id', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const { pushToken } = UpdatePushTokenSchema.parse(request.body);
    return { data: facade.updatePushToken(user, id, pushToken) };
  });

  app.delete('/api/v1/devices/:id', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    facade.deleteDevice(user, id);
    return reply.status(204).send();
  });

  /* ── 设备-分身绑定 ── */

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/avatars', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { avatarId } = InstallAvatarSchema.parse(request.body);
    const da = facade.installAvatar(user, request.params.id, avatarId);
    return reply.status(201).send({ data: da });
  });

  app.delete<{ Params: { id: string; avatarId: string } }>('/api/v1/devices/:id/avatars/:avatarId', async (request, reply) => {
    const user = request.user as JwtPayload;
    facade.uninstallAvatar(user, request.params.id, request.params.avatarId);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string; avatarId: string } }>('/api/v1/devices/:id/avatars/:avatarId/activate', async (request) => {
    const user = request.user as JwtPayload;
    return { data: facade.activateAvatar(user, request.params.id, request.params.avatarId) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/devices/:id/avatars', async (request) => {
    return { data: facade.listDeviceAvatars(request.user as JwtPayload, request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/push-test', async (request) => {
    const user = request.user as JwtPayload;
    const body = request.body as { title?: string; body?: string } | undefined;
    return { data: await facade.sendPushTest(user, request.params.id, body) };
  });
}
