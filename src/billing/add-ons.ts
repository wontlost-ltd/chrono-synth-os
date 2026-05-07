/**
 * 附加组件管理 — 薄适配器，委托 kernel 领域类型
 * SQL 由执行器层实现，种子数据来自 kernel
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { DEFAULT_ADD_ONS as KERNEL_DEFAULT_ADD_ONS } from '@chrono/kernel';
import type { KernelAddOn, AddOnRow } from '@chrono/kernel';
import {
  addonQueryByCode, addonQueryById, addonQueryListActive, addonQueryListAll,
  addonQueryCodeExists,
  addonCmdSeed, addonCmdCreate, addonCmdUpdate, addonCmdDeactivate,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type { KernelAddOn };

export interface AddOn {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly stripePriceId: string;
  readonly resource: string;
  readonly quotaAmount: number;
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function rowToAddOn(row: AddOnRow): AddOn {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    stripePriceId: row.stripe_price_id,
    resource: row.resource,
    quotaAmount: row.quota_amount,
    isActive: row.is_active === true || row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTx(tx: SyncWriteUnitOfWork): SyncWriteUnitOfWork {
  registerCoreSelfExecutors();
  return tx;
}

/** 初始化默认附加组件（幂等），种子数据来自 kernel */
export function seedDefaultAddOns(uowOrDb: SyncWriteUnitOfWork): void {
  const tx = getTx(uowOrDb);
  const now = Date.now();
  for (const def of KERNEL_DEFAULT_ADD_ONS) {
    const existing = tx.queryOne(addonQueryCodeExists(def.code));
    if (existing) continue;

    tx.execute(addonCmdSeed({
      id: `addon_${randomUUID()}`,
      code: def.code,
      name: def.name,
      description: def.description,
      resource: def.resource,
      quotaAmount: def.quotaAmount,
      now,
    }));
  }
}

/** 列出所有附加组件（可选仅活跃） */
export function listAddOns(uowOrDb: SyncWriteUnitOfWork, activeOnly = true): AddOn[] {
  const tx = getTx(uowOrDb);
  const rows = activeOnly
    ? tx.queryMany(addonQueryListActive())
    : tx.queryMany(addonQueryListAll());
  return rows.map(rowToAddOn);
}

/** 按 code 查找附加组件 */
export function getAddOnByCode(uowOrDb: SyncWriteUnitOfWork, code: string): AddOn | undefined {
  const tx = getTx(uowOrDb);
  const row = tx.queryOne(addonQueryByCode(code));
  return row ? rowToAddOn(row) : undefined;
}

/** 按 ID 查找附加组件 */
export function getAddOnById(uowOrDb: SyncWriteUnitOfWork, id: string): AddOn | undefined {
  const tx = getTx(uowOrDb);
  const row = tx.queryOne(addonQueryById(id));
  return row ? rowToAddOn(row) : undefined;
}

/** 创建附加组件 */
export function createAddOn(uowOrDb: SyncWriteUnitOfWork, data: Omit<AddOn, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>): AddOn {
  const tx = getTx(uowOrDb);
  const id = `addon_${randomUUID()}`;
  const now = Date.now();
  tx.execute(addonCmdCreate({
    id,
    code: data.code,
    name: data.name,
    description: data.description,
    stripePriceId: data.stripePriceId,
    resource: data.resource,
    quotaAmount: data.quotaAmount,
    now,
  }));
  return { ...data, id, isActive: true, createdAt: now, updatedAt: now };
}

/** 更新附加组件 */
export function updateAddOn(uowOrDb: SyncWriteUnitOfWork, id: string, data: Partial<Pick<AddOn, 'name' | 'description' | 'stripePriceId' | 'quotaAmount'>>): void {
  if (
    data.name === undefined &&
    data.description === undefined &&
    data.stripePriceId === undefined &&
    data.quotaAmount === undefined
  ) return;
  const tx = getTx(uowOrDb);
  tx.execute(addonCmdUpdate({
    id,
    name: data.name,
    description: data.description,
    stripePriceId: data.stripePriceId,
    quotaAmount: data.quotaAmount,
    now: Date.now(),
  }));
}

/** 停用附加组件 */
export function deactivateAddOn(uowOrDb: SyncWriteUnitOfWork, id: string): void {
  const tx = getTx(uowOrDb);
  tx.execute(addonCmdDeactivate({ id, now: Date.now() }));
}
