/**
 * 移动端设备管理 Application Façade
 * 封装设备注册、分身绑定、推送测试的业务逻辑
 */

import type { IDatabase } from '../storage/database.js';
import type { JwtPayload } from '../types/auth.js';
import type { PushService } from '../types/push.js';
import { IdentityService } from './identity-service.js';
import { AvatarService } from './avatar-service.js';
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
  private readonly identityService: IdentityService;
  private readonly avatarService: AvatarService;

  constructor(db: IDatabase, private readonly pushService: PushService) {
    this.deviceService = new MobileDeviceService(db);
    this.deviceAvatarService = new DeviceAvatarService(db);
    this.identityService = new IdentityService(db);
    this.avatarService = new AvatarService(db);
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
    return this.deviceAvatarService.install(deviceId, avatarId);
  }

  uninstallAvatar(user: JwtPayload, deviceId: string, avatarId: string): boolean {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    this.requireOwnedAvatar(user, avatarId);
    const ok = this.deviceAvatarService.uninstall(deviceId, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return true;
  }

  activateAvatar(user: JwtPayload, deviceId: string, avatarId: string): { deviceId: string; avatarId: string; active: true } {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    this.requireOwnedAvatar(user, avatarId);
    const ok = this.deviceAvatarService.activate(deviceId, avatarId);
    if (!ok) throw new NotFoundError('该分身未安装在此设备', ErrorCode.NOT_FOUND_AVATAR);
    return { deviceId, avatarId, active: true };
  }

  listDeviceAvatars(user: JwtPayload, deviceId: string) {
    this.deviceService.requireOwnedDevice(deviceId, user.sub);
    const identity = this.identityService.getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatars = this.deviceAvatarService.listByDevice(deviceId);
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
    const identity = this.identityService.getByUser(user.sub);
    if (!identity) throw new NotFoundError('身份不存在', ErrorCode.NOT_FOUND_IDENTITY);
    const avatar = this.avatarService.getByIdForIdentity(avatarId, identity.id);
    if (!avatar) throw new NotFoundError('分身不存在', ErrorCode.NOT_FOUND_AVATAR);
    return avatar;
  }
}
