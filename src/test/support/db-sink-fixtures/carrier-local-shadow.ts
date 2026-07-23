/**
 * capability-carrier 压缩 + **符号级** provenance —— 同名本地函数遮蔽（Plan 0 终审 Important 修复）。
 *
 * 背景：traceCarrierProvenance 原按**方法名字符串**判 resolver 入口（getTenantOS/getCore），
 * 未校验 callee 真实符号是否解析到 TenantOSFactory.getTenantOS / ChronoSynthOS.getCore。
 * 结果：一个**同名本地函数**（如 src/server/routes/avatars.ts 的本地 `getTenantOS`，其 default
 * 分支 `return os` 返回**未按租户路由的 root os**）被误判 resolved（安全），漏掉真·错-shard 隐患。
 *
 * 本 fixture 复刻 avatars.ts 的形态：一个本地 `getTenantOS` 有 default 分支返回 root os。
 * 收紧后：把它的返回传给下游 carrier-arg 应判 **unresolved-carrier**（因 callee 符号解析到
 * 本文件的 FunctionDeclaration，而非 TenantOSFactory.getTenantOS）。
 */
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { CoreRhythmLayer } from '../../../core/core-rhythm-layer.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import { useCore } from './carrier-safe.js';

/** ambient：真 resolver 工厂（供本地 getTenantOS 的**非** default 分支调用真 getTenantOS）。 */
declare const tenantFactory: TenantOSFactory | undefined;
/** ambient：root os（未按租户路由——default 分支直接返回它，正是危险来源）。 */
declare const rootOs: ChronoSynthOS;

/**
 * **本地同名** getTenantOS（FunctionDeclaration，非 TenantOSFactory 方法）——复刻 avatars.ts:37。
 * default 分支 `return rootOs` 返回未按租户路由的 root os；即使有 tenantFactory 分支，
 * 整体返回类型是 ChronoSynthOS，来源**不可**机械证明按租户解析（有 root-os 逃逸分支）。
 */
function getTenantOS(tenantId: string): ChronoSynthOS {
  if (tenantFactory && tenantId && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
  return rootOs;
}

/**
 * 危险：core 来自**本地** getTenantOS(...).core（本地函数遮蔽，非真 resolver 入口）→
 * 传给 useCore 的实参 edge 应归 **unresolved-carrier**（符号级校验：callee 非 TenantOSFactory.getTenantOS）。
 * 收紧前（纯名字匹配）会被误判 linked-to-resolved-carrier（安全）——变异自证锚点。
 */
export function shadowedLocalGetTenantOS(tenantId: string): void {
  const tenantOS = getTenantOS(tenantId);
  const core: CoreRhythmLayer = tenantOS.core;
  useCore(core);
}
