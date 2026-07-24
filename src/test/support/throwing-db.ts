/**
 * 可配置的「坏 shard」IDatabase 桩（分片 Phase 0 · Plan 2 公共测试脚手架，全 Plan 复用）。
 *
 * 跨 shard fan-out 的隔离/健康测试需要一个「某个方法恒抛错、其余 no-op」的最小 db 探针，用来断言
 * 一个坏 shard 抛错不拖累其余 shard（逐 shard try/catch 隔离）。此前 5 个 *-sharding.test.ts 各自内联
 * 了几乎相同的本地 throwingDb，差异只在**哪个方法抛错**（billing/quota/template 抛 `execute`；
 * persona-marketplace-recovery/persona-core 抛 `queryMany`）。本文件把它收编成单一可配置工厂。
 *
 * `on` 选择抛错的方法（默认 `execute`）；其余方法返回各自的自然空值（queryOne→null、queryMany→[]、
 * execute→{rowsAffected:0}、prepare→空语句、exec→void）——与被替代的 5 个本地桩逐一行为等价：
 *  - 抛 `execute` 时 queryMany 返 []（旧 billing/quota/template 桩即此形态）；
 *  - 抛 `queryMany` 时 execute 返 {rowsAffected:0}（旧 persona 桩即此形态）。
 * 抛错方法的返回值无意义（永不 return），故统一非抛错分支返回自然空值不改变任何一处旧语义。
 */

import type { IDatabase } from '../../storage/database.js';

/** 抛错方法选择：默认 `execute`。 */
export interface ThrowingDbOptions {
  readonly on?: 'execute' | 'queryMany' | 'queryOne' | 'prepare' | 'all';
}

/**
 * 建一个「指定方法恒抛错、其余 no-op」的最小 IDatabase 桩（仅供 shard 隔离/健康探针用，不接真库）。
 * 抛错固定为 `new Error('boom')`（与被替代的 5 个本地桩一致）。
 */
export function throwingDb(opts: ThrowingDbOptions = {}): IDatabase {
  const on = opts.on ?? 'execute';
  const boom = (): never => { throw new Error('boom'); };
  return {
    dialect: 'sqlite',
    exec: () => {},
    prepare: on === 'prepare' ? boom : () => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: on === 'all' ? boom : () => [],
    }),
    transaction: (fn: () => unknown) => fn(),
    transactionRollback: (fn: () => unknown) => fn(),
    close: () => {},
    queryOne: on === 'queryOne' ? boom : () => null,
    queryMany: on === 'queryMany' ? boom : () => [],
    execute: on === 'execute' ? boom : () => ({ rowsAffected: 0 }),
  } as unknown as IDatabase;
}
