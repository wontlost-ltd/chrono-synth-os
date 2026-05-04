/**
 * UoW 共享辅助（Phase 2 服务层迁移）
 *
 * 服务层目标：构造函数接受 `SyncWriteUnitOfWork | IDatabase`，内部统一持有
 * `SyncWriteUnitOfWork`，从而把对 `IDatabase` 的依赖收紧到适配层。
 * 这样多运行时（Web Worker / Tauri / RN）只需要提供 SyncWriteUnitOfWork
 * 实现，无需暴露 SQLite 风格的 IDatabase。
 *
 * 仍然保持同步语义：底层 SQLite query/execute 都是同步的；强行 async 化
 * 会触发对所有 caller（CoreRhythmLayer / MemoryFacade / 路由层）的级联
 * await 改造但带不来真实并发收益。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { IDatabase } from './database.js';
import { directUnitOfWork } from './direct-uow-adapter.js';

/**
 * 服务层构造函数可接受的工作单元参数：
 * - `IDatabase`：旧入口；内部通过 `directUnitOfWork` 包装
 * - `SyncWriteUnitOfWork`：新入口；调用方控制工作单元生命周期与租户作用域
 */
export type UowOrDb = IDatabase | SyncWriteUnitOfWork;

/** 类型守卫：区分 IDatabase 与 SyncWriteUnitOfWork */
export function isUow(x: UowOrDb): x is SyncWriteUnitOfWork {
  return typeof (x as SyncWriteUnitOfWork).execute === 'function'
    && typeof (x as SyncWriteUnitOfWork).queryOne === 'function'
    && typeof (x as SyncWriteUnitOfWork).queryMany === 'function';
}

/**
 * 把 `UowOrDb` 规范化为 `SyncWriteUnitOfWork`。
 * 服务层构造函数中调用一次，存到 `this.tx` 后续直接使用。
 */
export function asUow(x: UowOrDb): SyncWriteUnitOfWork {
  return isUow(x) ? x : directUnitOfWork(x);
}

/**
 * 提取底层 IDatabase（仅当 `UowOrDb` 是 IDatabase 形态时返回）。
 * 用于需要管理事务范围（`db.transaction()`）或加密握手等仍依赖
 * IDatabase 接口的场景。SyncWriteUnitOfWork 形态返回 `null`，调用方应
 * 通过 caller-controlled UoW 模式重写多步原子逻辑。
 */
export function unwrapDb(x: UowOrDb): IDatabase | null {
  return isUow(x) ? null : x;
}
