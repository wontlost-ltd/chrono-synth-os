/**
 * 租户分片 Phase 0 · Plan 1c Task 8 —— PENDING 预留恢复 worker。
 *
 * 混合作用域状态机（reserve 协调库 → 落 shard → activate 协调库）在两步之间崩溃会留下过期 PENDING
 * 目录项。本 worker 定时扫协调库过期 PENDING（`listPending(now - graceMs)`，仅 lookup_kind='email'——
 * token/api_key 直接 ACTIVE 无两段），按 `operation_kind` 分两支**收敛**，据 shard 权威事实补齐或回滚：
 *
 *   - **REGISTER**：查该租户 shard 的 `tenant_bootstrap`（按 operationId **per-operation** 匹配，非
 *     tenant 级、非「user 行存在」）——status=COMPLETE 证明用户已确认落 shard → CAS 补 ACTIVE；否则
 *     shard 未确认，**保留 + 告警**（绝不取消/删）。
 *   - **EMAIL_CHANGE**：读 shard user（按 userId）的 canonical email——== 新 email(lookup_value) 说明
 *     shard 已改成功、仅协调库 activate 前崩 → completeEmailChange（新 ACTIVE + 旧删）；== 旧
 *     email(previous_lookup_value) 说明 reserve 后 shard 改前崩 → rollbackEmailChange（删自己未竟的新
 *     PENDING，旧地址仍权威 ACTIVE）；第三个值（无法判定）→ 保留 + 告警，**不猜测**。
 *
 * 铁律（spec §4.1.6）：Phase 0 **绝不取消 PENDING**——取消缺 fencing token，会把「已在 shard 落地但
 * 协调库未 activate」的租户变成不可定位（新请求撞唯一键、老数据无入口）。宁可保留 + 告警等待下轮或
 * 人工介入。EMAIL_CHANGE 的 rollback 删的是**自己未竟的新 PENDING**（非取消原租户）——旧 email 仍权威。
 *
 * 鲁棒性：逐项 try/catch 隔离——单项失败（shard 无映射 / CAS 抛错等）计入 retained + 告警，不崩整个
 * 循环（否则一个坏项会永久卡住所有其他项的恢复）。
 */

import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import type { Logger } from '../utils/logger.js';
import { bootQueryByOperation, authQueryUserById } from '@chrono/kernel';
import { TenantIdentityDirectory, type PendingEntry } from './tenant-identity-directory.js';

const LAYER = 'TenantReservationRecovery';

export interface TenantReservationRecoveryOptions {
  /** 定时轮询间隔。 */
  pollIntervalMs: number;
  /** 宽限期：仅回收 updated_at 早于 now - graceMs 的 PENDING（避开正在进行的活跃工单）。 */
  graceMs: number;
}

/** 一轮 reconcile 的结果计数（各分支互斥累加，供 worker 告警与测试断言）。 */
export interface TenantReservationRecoveryRun {
  /** REGISTER 分支：bootstrap COMPLETE → 补 ACTIVE 的数量。 */
  activated: number;
  /** 保留（未取消）的数量：shard 未确认 / 无法判定 / 单项处理抛错。 */
  retained: number;
  /** EMAIL_CHANGE 分支：shard 已改到新 email → completeEmailChange 的数量。 */
  changesCompleted: number;
  /** EMAIL_CHANGE 分支：shard 仍是旧 email → rollbackEmailChange 的数量。 */
  changesRolledBack: number;
}

const DEFAULT_OPTIONS: TenantReservationRecoveryOptions = {
  pollIntervalMs: 5 * 60 * 1000,
  /* 24h 宽限：远长于正常 reserve→activate 单事务耗时，只回收真正被遗弃的工单。 */
  graceMs: 24 * 60 * 60 * 1000,
};

export class TenantReservationRecovery {
  private readonly options: TenantReservationRecoveryOptions;
  private readonly directory: TenantIdentityDirectory;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentRun: Promise<TenantReservationRecoveryRun> | undefined;

  constructor(
    private readonly resolver: TenantDbResolver,
    private readonly logger: Logger,
    options: Partial<TenantReservationRecoveryOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.directory = new TenantIdentityDirectory(resolver);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.error(LAYER, 'reservation recovery flush 失败', err);
      });
    }, this.options.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info(LAYER, `reservation recovery worker 已启动（poll=${this.options.pollIntervalMs}ms）`);
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  get inflight(): number {
    return this.currentRun ? 1 : 0;
  }

  async stop(drainTimeoutMs = 10_000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (!this.currentRun) return;

    const deadline = Date.now() + drainTimeoutMs;
    while (Date.now() < deadline) {
      const run = this.currentRun;
      if (!run) break;
      await run.catch(() => undefined);
    }
  }

  /** 单飞 flush：定时器与外部触发共享同一 in-flight run，避免并发重入。 */
  flush(): Promise<TenantReservationRecoveryRun> {
    if (this.currentRun) return this.currentRun;
    const run = Promise.resolve(this.reconcile(Date.now())).finally(() => {
      if (this.currentRun === run) {
        this.currentRun = undefined;
      }
    });
    this.currentRun = run;
    return run;
  }

  /**
   * 扫过期 email PENDING，按 operation_kind 收敛。纯同步、可注入 now（供测试与 flush 共用）。
   *
   * 逐项 try/catch：单项失败记 retained + 告警，绝不中断循环。绝不写取消/删 PENDING 分支
   * （EMAIL_CHANGE 的 rollback 删的是自己未竟的新 PENDING，非取消原租户）。
   */
  reconcile(now: number): TenantReservationRecoveryRun {
    const run: TenantReservationRecoveryRun = {
      activated: 0, retained: 0, changesCompleted: 0, changesRolledBack: 0,
    };
    for (const pending of this.directory.listPending(now - this.options.graceMs)) {
      try {
        this.reconcileOne(pending, run);
      } catch (err) {
        /* 单项失败隔离：不崩整个循环，保留该 PENDING（未取消），告警等待下轮 / 人工介入。 */
        run.retained += 1;
        this.logger.warn(LAYER, 'reservation reconcile 单项失败，保留待重试', {
          tenantId: pending.tenantId, operationId: pending.operationId,
          operationKind: pending.operationKind, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (run.activated > 0 || run.retained > 0 || run.changesCompleted > 0 || run.changesRolledBack > 0) {
      this.logger.info(LAYER, 'reservation recovery 一轮完成', run);
    }
    return run;
  }

  /** 处理单条过期 PENDING（据 operation_kind 分支）。抛错由 reconcile 逐项捕获。 */
  private reconcileOne(pending: PendingEntry, run: TenantReservationRecoveryRun): void {
    if (pending.operationKind === 'REGISTER') {
      this.reconcileRegister(pending, run);
    } else if (pending.operationKind === 'EMAIL_CHANGE') {
      this.reconcileEmailChange(pending, run);
    } else {
      /* 其他 operation_kind（token/key 不会以 PENDING 出现，此处仅防御性告警）→ 保留，不取消。 */
      run.retained += 1;
      this.logger.warn(LAYER, 'reservation reconcile 未知 operation_kind，保留', {
        tenantId: pending.tenantId, operationKind: pending.operationKind,
      });
    }
  }

  /**
   * REGISTER：按 operationId per-op 查 shard bootstrap——COMPLETE 才补 ACTIVE，否则保留 + 告警。
   * 绝不取消（shard 可能已落地但协调库未 activate，取消会留不可定位租户）。
   */
  private reconcileRegister(pending: PendingEntry, run: TenantReservationRecoveryRun): void {
    const shardDb = this.resolver.dbForTenant(pending.tenantId);
    const boot = shardDb.queryOne(bootQueryByOperation(pending.tenantId, pending.operationId));
    if (boot?.status === 'COMPLETE') {
      this.directory.activateTenant({ email: pending.lookupValue, operationId: pending.operationId });
      run.activated += 1;
      return;
    }
    run.retained += 1;
    this.logger.warn(LAYER, 'register reservation 保留（shard 未确认落地，绝不取消）', {
      tenantId: pending.tenantId, operationId: pending.operationId,
    });
  }

  /**
   * EMAIL_CHANGE：读 shard user canonical email 收敛——== 新 → complete；== 旧 → rollback（删自己未竟
   * 的新 PENDING）；其他值 → 保留 + 告警不猜测。两窗口 reconcile 后都保证至少一个 email ACTIVE 可 login。
   */
  private reconcileEmailChange(pending: PendingEntry, run: TenantReservationRecoveryRun): void {
    const shardDb = this.resolver.dbForTenant(pending.tenantId);
    const shardEmail = pending.userId === null
      ? null
      : shardDb.queryOne(authQueryUserById(pending.userId))?.email ?? null;
    if (shardEmail === pending.lookupValue) {
      /* shard 已改到新 email → 完成改名（新 ACTIVE + 旧删）。previous 非空由 EMAIL_CHANGE reserve 保证。 */
      this.directory.completeEmailChange({
        oldEmail: pending.previousLookupValue!, newEmail: pending.lookupValue, operationId: pending.operationId,
      });
      run.changesCompleted += 1;
      return;
    }
    if (shardEmail === pending.previousLookupValue) {
      /* shard 仍是旧 email → 回滚（删自己未竟的新 PENDING，旧地址仍权威 ACTIVE，非取消原租户）。 */
      this.directory.rollbackEmailChange({ newEmail: pending.lookupValue, operationId: pending.operationId });
      run.changesRolledBack += 1;
      return;
    }
    run.retained += 1;
    this.logger.warn(LAYER, 'email-change reservation 保留（shard email 既非新也非旧，不猜测）', {
      tenantId: pending.tenantId, operationId: pending.operationId,
    });
  }
}
