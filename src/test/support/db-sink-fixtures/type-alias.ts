/**
 * 类型判定单元测样本 —— canonical / alias / 结构兼容 / union / generic / 非 DB negative。
 *
 * 这些声明专供 db-sink-scanner 的「类型驱动」判定测试探针（probeType）读取，
 * 不参与任何运行逻辑，只是提供覆盖各种 DB-capability 形态的静态类型。
 *
 * 关键验收锚：StructuralUow 只含 SyncWriteUnitOfWork 的 4 个方法（不 extends、
 * 不含 IDatabase 的 dialect/exec/prepare/close），必须被判为 DB 能力——
 * 由此证明检测上界是 SyncWriteUnitOfWork 而非更严的 IDatabase。
 */
import type { IDatabase } from '../../../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';

/** 别名：完全等价于 IDatabase。 */
export type DbAlias = IDatabase;

/**
 * 结构兼容：仅重复 SyncWriteUnitOfWork 的 4 个方法（queryOne/queryMany/execute/transaction），
 * 既不 extends 也不含 IDatabase 独有的 dialect/exec/prepare/transactionRollback/close。
 * 必须判 true —— 这是「检测上界 = UoW 而非 IDatabase」的验收锚。
 */
export interface StructuralUow {
  queryOne: SyncWriteUnitOfWork['queryOne'];
  queryMany: SyncWriteUnitOfWork['queryMany'];
  execute: SyncWriteUnitOfWork['execute'];
  transaction: SyncWriteUnitOfWork['transaction'];
}

/** union | undefined：db 参数类型为 IDatabase | undefined，须逐分量判定。 */
export function optionalDb(db?: IDatabase): void {
  void db;
}

/** generic 约束：tx 参数类型为 T extends SyncWriteUnitOfWork，须取 base constraint。 */
export function genericDb<T extends SyncWriteUnitOfWork>(tx: T): void {
  void tx;
}

/** negative control：与 DB 能力无关的普通结构，必须判 false。 */
export interface NotDb {
  foo: string;
}
