/**
 * 主动消息 → 系统推送桥（ADR-0054 ③ OS 推送）。
 *
 * 订阅 companion:nudge-created（数字人主动开口）→ 解析租户用户 → 各用户设备 → 同意门控（红线9）
 * → 推送投递。**桥在服务层**——核心 ChronoSynthOS 不认识 user/device/push（那是 server 层概念）。
 *
 * 红线（ADR-0054）：
 *   - 红线9：默认关（无同意不推）+ 安静时段（夜间不打扰）。consent 由 evaluateNotificationGate 判。
 *   - 隐私：系统通知**不带 nudge 正文**——只「你的数字人有话想说」+ tap-to-open data{nudgeId}；
 *     正文仍经认证 GET /companion/me/nudges 取，消息内容绝不进系统通知 payload（同 SSE 边界）。
 *   - 失败隔离：订阅回调同步返回不抛（push 是 async fire-and-forget）；任何一步失败不污染触发它的
 *     bus.emit（记忆写入/蒸馏主流程）。
 *
 * 时区：安静时段当前按 **UTC** 解释（per-user 时区是登记的后续债——需在 user/pref 存时区）。
 */

import type { EventBus } from '../../events/event-bus.js';
import type { IDatabase } from '../../storage/database.js';
import type { Logger } from '../../utils/logger.js';
import type { PushService } from '../../types/push.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { NotificationPreferenceStore } from '../../storage/notification-preference-store.js';
import { evaluateNotificationGate, scimQueryUsers, type ScimUserRow } from '@chrono/kernel';

const LAYER = 'NudgePushBridge';

/** 一租户最多解析多少用户（companion 通常 1 个；上限防异常租户拖垮）。 */
const MAX_USERS_PER_TENANT = 50;

export interface NudgePushBridgeDeps {
  readonly bus: EventBus;
  /** 宿主 DB（解析 users / devices / 同意偏好）。 */
  readonly db: IDatabase;
  readonly pushService: PushService;
  readonly logger: Logger;
  /** epoch ms 时钟（测试注入）。 */
  readonly now: () => number;
}

export class NudgePushBridge {
  private listener: ((payload: { tenantId?: string; nudgeId?: string }) => void) | null = null;

  constructor(private readonly deps: NudgePushBridgeDeps) {}

  start(): void {
    if (this.listener) return;
    this.listener = (payload) => this.onNudge(payload);
    this.deps.bus.on('companion:nudge-created', this.listener as never);
  }

  stop(): void {
    if (this.listener) {
      this.deps.bus.off('companion:nudge-created', this.listener as never);
      this.listener = null;
    }
  }

  /** 同步入口：校验 + 触发 async 投递（fire-and-forget，绝不抛进 bus.emit）。 */
  private onNudge(payload: { tenantId?: string; nudgeId?: string }): void {
    /* 红线7：缺 tenantId 直接 drop（不默认归 default）。 */
    if (typeof payload.tenantId !== 'string' || typeof payload.nudgeId !== 'string') return;
    void this.deliver(payload.tenantId, payload.nudgeId).catch((err) => {
      this.deps.logger.error(LAYER, `主动消息推送失败（已隔离，不影响主流程）`, err as Error);
    });
  }

  private async deliver(tenantId: string, nudgeId: string): Promise<void> {
    const users = this.resolveUsers(tenantId);
    if (users.length === 0) return;

    /* UTC 当日分钟数（per-user 时区是后续债——见模块注释）。 */
    const nowMs = this.deps.now();
    const utcNowMinute = Math.floor((nowMs % 86_400_000) / 60_000);

    const deviceService = new MobileDeviceService(this.deps.db);
    const prefStore = new NotificationPreferenceStore(this.deps.db, this.deps.now, tenantId);

    for (const user of users) {
      /* 红线9：同意门控（默认关 + 安静时段）。fail-closed 已由 UTC 计算稳定保证。 */
      const decision = evaluateNotificationGate(prefStore.get(user.id), utcNowMinute);
      if (!decision.deliver) continue;

      /* 宿主 DB 上必须按 (tenantId, userId) 列设备——listByUser 无 tenant 谓词有跨租户风险
       * （Codex 退回 High）。 */
      const devices = deviceService.listByTenantUser(tenantId, user.id).filter((d) => !!d.pushToken);
      for (const device of devices) {
        /* 隐私：payload **不带 nudge 正文**——只刷新提示 + tap-to-open data。 */
        await this.deps.pushService.send(
          tenantId,
          device.id,
          {
            title: '你的数字人有话想说',
            body: '打开看看 TA 最近的想法。',
            data: { type: 'nudge', nudgeId },
          },
          { priority: 'normal', collapseKey: 'companion-nudge' },
        );
      }
    }
  }

  /** 解析租户下的用户（companion 通常 1 个）。失败 → 空数组（降级，不抛）。 */
  private resolveUsers(tenantId: string): ScimUserRow[] {
    try {
      return [...this.deps.db.queryMany(scimQueryUsers({ tenantId, count: MAX_USERS_PER_TENANT, offset: 0 }))];
    } catch {
      return [];
    }
  }
}
