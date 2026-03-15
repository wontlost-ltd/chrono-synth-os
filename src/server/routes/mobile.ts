/**
 * 移动端设备管理路由
 * POST   /api/v1/devices             — 注册/更新设备
 * DELETE /api/v1/devices/:id         — 注销设备
 * PATCH  /api/v1/devices/:id         — 更新推送 token
 * GET    /api/v1/devices             — 获取当前用户设备列表
 * POST   /api/v1/devices/:id/push-test — 发送测试推送
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { RegisterDeviceSchema, UpdatePushTokenSchema, InstallAvatarSchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { DeviceAvatarService } from '../../identity/device-avatar-service.js';
import { MockPushService } from '../services/push-service.js';

export function registerMobileRoutes(app: FastifyInstance, db: IDatabase): void {
  const deviceService = new MobileDeviceService(db);
  const deviceAvatarService = new DeviceAvatarService(db);
  const identityService = new IdentityService(db);
  const avatarService = new AvatarService(db);

  function requireOwnedAvatar(user: JwtPayload, avatarId: string) {
    const identity = identityService.getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatar = avatarService.getByIdForIdentity(avatarId, identity.id);
    if (!avatar) throw new NotFoundError('分身不存在', ErrorCode.NOT_FOUND_AVATAR);
    return avatar;
  }

  app.post('/api/v1/devices', async (request) => {
    const user = request.user as JwtPayload;
    const { deviceUid, platform, pushToken, appVersion } = RegisterDeviceSchema.parse(request.body);
    const result = deviceService.register(user.tenantId, user.sub, { deviceUid, platform, pushToken, appVersion });
    return { data: result };
  });

  app.get('/api/v1/devices', async (request) => {
    const user = request.user as JwtPayload;
    return { data: deviceService.listByUser(user.sub) };
  });

  app.patch('/api/v1/devices/:id', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const { pushToken } = UpdatePushTokenSchema.parse(request.body);
    const result = deviceService.updatePushToken(id, user.sub, pushToken);
    return { data: result };
  });

  app.delete('/api/v1/devices/:id', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    deviceService.delete(id, user.sub);
    return reply.status(204).send();
  });

  /* ── 设备-分身绑定 ── */

  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/avatars', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;
    const { avatarId } = InstallAvatarSchema.parse(request.body);
    deviceService.requireOwnedDevice(id, user.sub);
    requireOwnedAvatar(user, avatarId);
    const da = deviceAvatarService.install(id, avatarId);
    return reply.status(201).send({ data: da });
  });

  app.delete<{ Params: { id: string; avatarId: string } }>('/api/v1/devices/:id/avatars/:avatarId', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id, avatarId } = request.params;
    deviceService.requireOwnedDevice(id, user.sub);
    requireOwnedAvatar(user, avatarId);
    const ok = deviceAvatarService.uninstall(id, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string; avatarId: string } }>('/api/v1/devices/:id/avatars/:avatarId/activate', async (request) => {
    const user = request.user as JwtPayload;
    const { id, avatarId } = request.params;
    deviceService.requireOwnedDevice(id, user.sub);
    requireOwnedAvatar(user, avatarId);
    const ok = deviceAvatarService.activate(id, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return { data: { deviceId: id, avatarId, active: true } };
  });

  app.get<{ Params: { id: string } }>('/api/v1/devices/:id/avatars', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;
    deviceService.requireOwnedDevice(id, user.sub);
    const identity = identityService.getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatars = deviceAvatarService.listByDevice(id);
    return { data: avatars.filter((avatar) => avatar.identityId === identity.id) };
  });

  const pushService = new MockPushService();
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/push-test', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;
    deviceService.requireOwnedDevice(id, user.sub);
    const body = request.body as { title?: string; body?: string } | undefined;
    await pushService.send(user.tenantId, id, {
      title: body?.title ?? 'ChronoSynthOS 测试推送',
      body: body?.body ?? '这是一条测试推送通知',
      data: { type: 'push_test', deviceId: id },
    });
    return { data: { sent: true, channel: pushService.channel, deviceId: id } };
  });
}
