/**
 * 移动端设备管理路由
 * POST   /api/v1/devices             — 注册/更新设备
 * DELETE /api/v1/devices/:id         — 注销设备
 * PATCH  /api/v1/devices/:id         — 更新推送 token
 * GET    /api/v1/devices             — 获取当前用户设备列表
 * POST   /api/v1/devices/:id/push-test — 发送测试推送
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { RegisterDeviceSchema, UpdatePushTokenSchema, InstallAvatarSchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { DeviceAvatarService } from '../../identity/device-avatar-service.js';
import { MockPushService } from '../services/push-service.js';

interface DeviceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly device_uid: string;
  readonly platform: string;
  readonly push_token: string | null;
  readonly app_version: string | null;
  readonly last_seen_at: number;
  readonly created_at: number;
}

export function registerMobileRoutes(app: FastifyInstance, db: IDatabase): void {
  const deviceAvatarService = new DeviceAvatarService(db);

  /* POST /api/v1/devices — 注册设备（幂等：同一 device_uid 更新而非新增） */
  app.post('/api/v1/devices', async (request) => {
    const user = request.user as JwtPayload;
    const { deviceUid, platform, pushToken, appVersion } = RegisterDeviceSchema.parse(request.body);
    const now = Date.now();

    const existing = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND user_id = ? AND device_uid = ?',
    ).get(user.tenantId, user.sub, deviceUid);

    if (existing) {
      db.prepare<void>(
        'UPDATE devices SET platform = ?, push_token = ?, app_version = ?, last_seen_at = ? WHERE id = ?',
      ).run(platform, pushToken ?? null, appVersion ?? null, now, existing.id);
      return { data: { id: existing.id, deviceUid, platform, updated: true } };
    }

    const id = `dev_${randomUUID()}`;
    db.prepare<void>(
      `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, push_token, app_version, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.tenantId, user.sub, deviceUid, platform, pushToken ?? null, appVersion ?? null, now, now);

    return { data: { id, deviceUid, platform, updated: false } };
  });

  /* GET /api/v1/devices — 获取当前用户的设备列表 */
  app.get('/api/v1/devices', async (request) => {
    const user = request.user as JwtPayload;
    const rows = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC',
    ).all(user.sub);

    return {
      data: rows.map(r => ({
        id: r.id,
        deviceUid: r.device_uid,
        platform: r.platform,
        pushToken: r.push_token,
        appVersion: r.app_version,
        lastSeenAt: r.last_seen_at,
        createdAt: r.created_at,
      })),
    };
  });

  /* PATCH /api/v1/devices/:id — 更新推送 token */
  app.patch('/api/v1/devices/:id', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const { pushToken } = UpdatePushTokenSchema.parse(request.body);

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);

    if (!device) {
      throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);
    }

    db.prepare<void>(
      'UPDATE devices SET push_token = ?, last_seen_at = ? WHERE id = ?',
    ).run(pushToken, Date.now(), id);

    return { data: { id, pushToken, updated: true } };
  });

  /* DELETE /api/v1/devices/:id — 注销设备 */
  app.delete('/api/v1/devices/:id', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);

    if (!device) {
      throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);
    }

    db.prepare<void>('DELETE FROM devices WHERE id = ?').run(id);
    return reply.status(204).send();
  });

  /* ── 设备-分身绑定 ── */

  /* POST /api/v1/devices/:id/avatars — 安装分身到设备 */
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/avatars', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;
    const { avatarId } = InstallAvatarSchema.parse(request.body);

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);
    if (!device) throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);

    const da = deviceAvatarService.install(id, avatarId);
    return reply.status(201).send({ data: da });
  });

  /* DELETE /api/v1/devices/:id/avatars/:avatarId — 从设备卸载分身 */
  app.delete<{ Params: { id: string; avatarId: string } }>('/api/v1/devices/:id/avatars/:avatarId', async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id, avatarId } = request.params;

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);
    if (!device) throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);

    const ok = deviceAvatarService.uninstall(id, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return reply.status(204).send();
  });

  /* POST /api/v1/devices/:id/avatars/:avatarId/activate — 激活设备上的分身 */
  app.post<{ Params: { id: string; avatarId: string } }>('/api/v1/devices/:id/avatars/:avatarId/activate', async (request) => {
    const user = request.user as JwtPayload;
    const { id, avatarId } = request.params;

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);
    if (!device) throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);

    const ok = deviceAvatarService.activate(id, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return { data: { deviceId: id, avatarId, active: true } };
  });

  /* GET /api/v1/devices/:id/avatars — 列出设备上已安装的分身 */
  app.get<{ Params: { id: string } }>('/api/v1/devices/:id/avatars', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);
    if (!device) throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);

    const avatars = deviceAvatarService.listByDevice(id);
    return { data: avatars };
  });

  /* POST /api/v1/devices/:id/push-test — 发送测试推送（开发调试用） */
  const pushService = new MockPushService();
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/push-test', async (request) => {
    const user = request.user as JwtPayload;
    const { id } = request.params;

    const device = db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(id, user.sub);
    if (!device) throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);

    const body = request.body as { title?: string; body?: string } | undefined;
    await pushService.send(user.tenantId, id, {
      title: body?.title ?? 'ChronoSynthOS 测试推送',
      body: body?.body ?? '这是一条测试推送通知',
      data: { type: 'push_test', deviceId: id },
    });

    return { data: { sent: true, channel: pushService.channel, deviceId: id } };
  });
}
