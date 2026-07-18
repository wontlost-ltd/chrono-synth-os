/**
 * PersonaCore 双入口化的共享结构类型（租户分片 Phase 0）。
 *
 * 独立成文件是为避免 facade ↔ 子服务的循环依赖：facade 构造子服务、子服务需要这两个
 * 结构类型，若定义在 facade 内则子服务 import facade 形成环。放这里，双方各自 import。
 *
 * 设计对齐 QuotaManager / BillingOutbox 的 `fromResolver`/`fromUnitOfWork` 双入口范式：
 *   - resolver 模式：per-tenant 经 `forTenant(tenantId)` 选 shard db；cross-tenant 经 `allDbs()` fan-out。
 *   - bound-UoW 模式：`forTenant` 忽略 tenantId 恒返该事务，`allDbs()` 返 [tx]（结构上不脱离事务）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';

/**
 * 事务内 db 访问上下文。故意用 `Pick` 收窄——**不暴露 `transaction`**，使 InTx 方法在
 * 编译期无法调 `tx.transaction()`，把「禁止嵌套事务」从架构约定升级为结构性禁止。
 *
 * 运行时仍传原 db（IDatabase / SyncWriteUnitOfWork）对象，只是静态类型层看不到 transaction。
 * SQLite 平坦 BEGIN 不可嵌套；PG 内层取独立 client 独立提交（外层回滚撤不回内层=真部分提交），
 * 因此在类型层禁死嵌套是本片的安全命脉之一。
 */
export type TransactionContext = Pick<SyncWriteUnitOfWork, 'queryOne' | 'queryMany' | 'execute'>;

/**
 * 内部 db 取源：resolver 模式按 tenantId 解析对应 shard；UoW 模式固定该事务。
 * facade 与 4 个子服务共享同一个 source 实例——保证同 tenantId 在 facade 与子服务解析到
 * 同一物理 db（dbForTenant 确定性 + 连接池 connStr 去重），是跨子服务不裂脑的前提。
 */
export interface PersonaCoreSource {
  /** per-tenant 操作取 db（单库 / UoW 模式恒返同一 db）。 */
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  /** cross-tenant fan-out 的所有 shard db（UoW 模式返 [tx]）。recoverTimedOut 用。 */
  allDbs(): SyncWriteUnitOfWork[];
}
