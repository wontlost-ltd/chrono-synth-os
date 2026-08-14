/**
 * capability-carrier 压缩 + resolved provenance —— **安全**样本（Task 2.6，Codex 第 8 轮）。
 *
 * 背景：ChronoSynthOS / CoreRhythmLayer 之类 facade 内部对象图里散布大量 `.tx`（per-tenant
 * db 句柄）。findDbCapabilityPaths 若逐个展开，一个 `os: ChronoSynthOS` 参数会炸出几十条
 * `os.core.X.tx` deep edge（chat.ts 单文件 171+）。Task 2.6 把「类型为 carrier 的参数/字段」
 * **压成一条 carrier sink**（内部 .tx paths 存 edge.capabilityPaths 作证据），不逐 path 产 edge。
 *
 * 但压缩**不等于**按类型名放行——carrier 携带的是 per-tenant 能力，安全性取决于它**从哪来**：
 *  - 来源 = TenantOSFactory.getTenantOS(tid) / os.getCore(pid)（producer-manifest 登记的
 *    resolver 入口）→ carrier 已按租户/人格解析 → `linked-to-resolved-carrier`（安全）。
 *
 * 本文件全是**安全来源**：os 来自 factory.getTenantOS(tid)，core 来自 os.getCore(pid)。
 * 断言：把它们传给下游函数的 factory-indirect edge 应归 `linked-to-resolved-carrier`。
 */
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { CoreRhythmLayer } from '../../../core/core-rhythm-layer.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';

/** ambient：resolver 工厂（getTenantOS 是 producer-manifest 登记的 resolver 入口）。 */
declare const factory: TenantOSFactory;

/**
 * 下游消费者：接一个 ChronoSynthOS carrier 参数。
 * carrier 压缩：`os: ChronoSynthOS` 是 carrier 类型（内部对象图含 .tx sink，自身不可赋 UoW）
 * → 产**一条** carrier-param sink（param=os），内部 .core.X.tx paths 进 capabilityPaths，
 * 不逐 path 产 fn-param edge。
 */
export function useOs(os: ChronoSynthOS): void {
  void os;
}

/** 下游消费者：接一个 CoreRhythmLayer carrier 参数（同样压成一条 carrier-param）。 */
export function useCore(core: CoreRhythmLayer): void {
  void core;
}

/**
 * 安全来源①：os 来自 factory.getTenantOS(tid)（resolver 入口）→ 传给 useOs 的实参 edge
 * 应归 linked-to-resolved-carrier（provenance 跟到 getTenantOS）。
 */
export function safeOsFromFactory(tid: string): void {
  const os = factory.getTenantOS(tid);
  useOs(os);
}

/**
 * 安全来源②：core 来自 os.getCore(pid)（persona resolver 入口，os 本身又来自 getTenantOS）→
 * 传给 useCore 的实参 edge 应归 linked-to-resolved-carrier（provenance 跟 getTenantOS→.core?→getCore）。
 */
export function safeCoreFromGetCore(tid: string, pid: string): void {
  const os = factory.getTenantOS(tid);
  const core = os.getCore(pid);
  useCore(core);
}
