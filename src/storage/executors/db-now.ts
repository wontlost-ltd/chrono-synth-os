import type { IDatabase } from '../database.js';

/**
 * 「数据库当前时刻」的毫秒 epoch **SQL 表达式**。
 *
 * ## 为什么必须由数据库求值
 *
 * outbox 类表由**多个进程**共享，认领与回收若各用本机 `Date.now()`，机器钟差会直接平移
 * stale 判定 —— 钟差 > staleProcessingMs 时，**正在处理中的行被误判为 stale 重新入队**。
 * 让两侧都取同一个 DB 时钟，物理上消除多时钟。
 *
 * ⚠️ 这是**注入 Clock 解决不了**的一类问题：跨机器的物理钟差依然存在。
 * 判据：风险不在「有没有 clock」，而在**「写时间戳的时钟」与「比较时间戳的时钟」是否同源**。
 *
 * ⚠️ 下面**只是已改用本助手的表，不是受影响表的完整清单**：
 *   - `observability_outbox`（issue #380）：API replicas 各自起 ObservabilityPipelineService
 *     （`app.ts`）+ 独立 worker 副本 = 多进程一张表。
 *   - `billing_outbox`（issue #393）：flush 定时器跑在 **API 进程内**（`app.ts` 60s setInterval），
 *     多副本各自认领/回收同一张表。
 *
 * 独立审查扫出**同型但尚未修**的表（见 issue，勿把本清单当作「其余都安全」）：
 *   `tasks`（reaper 误回收会 retry_count+1，重跑别的副本正在执行的任务）、
 *   `runtime_sessions.timeout_at`、`persona_leases.expires_at`（跨副本互斥原语，
 *   「同源」在此处按定义不成立）、`tenant_identity_directory`、
 *   `bulk_knowledge_import_jobs`（潜伏：reapStuck 暂无生产调用方）。
 *
 * ## 方言差异（均已实测）
 *
 *   - PG    ：`now()` 在**事务内冻结** —— 正是所需语义（认领与回收各自单语句，互不干扰）。
 *             `EXTRACT(EPOCH FROM now())*1000` 得毫秒，`::bigint` 与列类型一致。
 *   - SQLite：`strftime('%s','now')` 只有**秒级**精度（实测比 `Date.now()` 落后 0–999ms）。
 *             对 staleProcessingMs 最小 1000ms、默认 5min 的窗口无实质影响。
 *
 * ⚠️ **PG 分支无自动化测试覆盖**：全仓没有跑 outbox 的 PG 集成测试（单测走 SQLite）。
 * 我在真实 PG 17 上手工对拍过（fresh 保持 processing、stuck 被回收，与 SQLite 一致），
 * 但那不是可复现的门。若后续补 outbox 的 PG 集成测试，请优先覆盖这些 SQL。
 *
 * ⚠️ 返回的是 **SQL 片段**而非参数：时间必须由数据库求值，一旦变成占位符参数就又回到
 * 「应用侧时钟」，缺陷原样复现。故此处刻意拼接常量片段（无外部输入，不构成注入面）。
 */
export function dbNowMs(db: IDatabase): string {
  return db.dialect === 'postgres'
    ? '(EXTRACT(EPOCH FROM now()) * 1000)::bigint'
    : "(CAST(strftime('%s','now') AS INTEGER) * 1000)";
}
