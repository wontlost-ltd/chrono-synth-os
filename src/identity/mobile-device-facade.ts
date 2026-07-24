/**
 * 移动端设备管理 Application Façade
 * 封装设备注册、分身绑定、推送测试的业务逻辑
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { JwtPayload } from '../types/auth.js';
import type { PushService } from '../types/push.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { IdentityWriter } from './identity-service.js';
import { AvatarWriter } from './avatar-service.js';
import { MobileDeviceService } from './mobile-device-service.js';
import { DeviceAvatarService } from './device-avatar-service.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

export interface RegisterDeviceInput {
  readonly deviceUid: string;
  readonly platform: string;
  readonly pushToken?: string;
  readonly appVersion?: string;
}

export class MobileDeviceFacade {
  private readonly deviceService: MobileDeviceService;
  private readonly deviceAvatarService: DeviceAvatarService;

  /**
   * 分片 Plan 1b：facade 持 `tx`，身份读/分身读经 tenant-bound `IdentityWriter`/`AvatarWriter(user.tenantId, tx)` seam
   * （非 `new IdentityService/AvatarService(tx)`）。`DeviceAvatarService` 已 resolver 化（Task 2 Avatar 组）故收 `resolver`。
   * `MobileDeviceService`（device 表）的多-shard resolver 化归 Task 3（Mobile 组），本 Task 只接线到 seam。
   */
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    resolver: TenantDbResolver,
    private readonly pushService: PushService,
  ) {
    this.deviceService = new MobileDeviceService(tx);
    this.deviceAvatarService = new DeviceAvatarService(resolver);
  }

  /** 用调用方 JWT 的 tenantId 现造 tenant-bound 身份读内核（不缓存）。 */
  private identityWriter(user: JwtPayload): IdentityWriter {
    return new IdentityWriter(user.tenantId, this.tx);
  }

  /** 用调用方 JWT 的 tenantId 现造 tenant-bound 分身读内核（不缓存）。 */
  private avatarWriter(user: JwtPayload): AvatarWriter {
    return new AvatarWriter(user.tenantId, this.tx);
  }

  register(user: JwtPayload, input: RegisterDeviceInput) {
    return this.deviceService.register(user.tenantId, user.sub, input);
  }

  listDevices(user: JwtPayload) {
    return this.deviceService.listByUser(user.sub);
  }

  updatePushToken(user: JwtPayload, deviceId: string, pushToken: string) {
    return this.deviceService.updatePushToken(deviceId, user.sub, pushToken);
  }

  deleteDevice(user: JwtPayload, deviceId: string): void {
    this.deviceService.delete(deviceId, user.sub);
  }

  installAvatar(user: JwtPayload, deviceId: string, avatarId: string) {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    this.requireOwnedAvatar(user, avatarId);
    return this.deviceAvatarService.install(user.tenantId, deviceId, avatarId);
  }

  uninstallAvatar(user: JwtPayload, deviceId: string, avatarId: string): boolean {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    this.requireOwnedAvatar(user, avatarId);
    const ok = this.deviceAvatarService.uninstall(user.tenantId, deviceId, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return true;
  }

  activateAvatar(user: JwtPayload, deviceId: string, avatarId: string): { deviceId: string; avatarId: string; active: true } {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    this.requireOwnedAvatar(user, avatarId);
    const ok = this.deviceAvatarService.activate(user.tenantId, deviceId, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return { deviceId, avatarId, active: true };
  }

  listDeviceAvatars(user: JwtPayload, deviceId: string) {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    const identity = this.identityWriter(user).getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatars = this.deviceAvatarService.listByDevice(user.tenantId, deviceId);
    return avatars.filter((avatar) => avatar.identityId === identity.id);
  }

  async sendPushTest(user: JwtPayload, deviceId: string, body?: { title?: string; body?: string }) {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    await this.pushService.send(user.tenantId, deviceId, {
      title: body?.title ?? 'ChronoSynthOS 测试推送',
      body: body?.body ?? '这是一条测试推送通知',
      data: { type: 'push_test', deviceId },
    });
    return { sent: true, channel: this.pushService.channel, deviceId };
  }

  private requireOwnedAvatar(user: JwtPayload, avatarId: string) {
    const identity = this.identityWriter(user).getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatar = this.avatarWriter(user).getByIdForIdentity(avatarId, identity.id);
    if (!avatar) throw new NotFoundError('分身不存在', ErrorCode.NOT_FOUND_AVATAR);
    return avatar;
  }
}
