/**
 * @chrono/data-plane — 数据平面契约与运行时适配描述
 */

export type DataPlaneRuntimeTarget = 'node' | 'web-worker' | 'tauri' | 'react-native';

export interface DataPlaneAdapterDescriptor {
  readonly id: string;
  readonly runtime: DataPlaneRuntimeTarget;
  readonly durable: boolean;
  readonly transactional: boolean;
}

export interface DataPlaneAdapterContract {
  readonly descriptor: DataPlaneAdapterDescriptor;
}

export interface DataPlaneBootstrapOptions {
  readonly runtime: DataPlaneRuntimeTarget;
}

export * from './ledger/index.js';
export * from './projection/index.js';
export * from './crypto/index.js';
export * from './contracts/field-crypto.js';
export * from './contracts/authority-mode.js';
export * from './write-coordinator.js';
export * from './tables-primary-coordinator.js';
