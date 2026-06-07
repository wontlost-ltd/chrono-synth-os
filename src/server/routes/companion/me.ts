/**
 * ChronoCompanion C 端路由 —「我的数字人」主页 + 成长视图（ADR-0046 / roadmap Phase 2.1）。
 *
 * 路由层只做：plan 门控 + 读取内核数据 + 映射成 C 端 DTO + 序列化。所有数据来自既有
 * 慢层（tenantOS.core.values / memories / narrative）与既有漂移分析器（PersonaDriftAnalyzer，
 * 企业版同款），**不新增业务逻辑**——companion 是同一内核的另一个外壳。
 *
 * 关键语义转换：企业版把 persona drift 渲染成「policy violation / alert」，companion 把
 * 同一份 DriftReport 重新组织成「你最近探索的方向」（见 driftReportToGrowth）。这是 ADR-0046
 * 双产品「同内核两外壳」的核心证明点（roadmap Phase 2 退出条件 5.2）。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';
import type { JwtPayload } from '../../../types/auth.js';
import { AuthorizationError, ErrorCode } from '../../../errors/index.js';
import {
  PersonaDriftAnalyzer,
  resolveDriftThresholds,
  type DriftReport,
  type ValueDrift,
} from '../../../safety/persona-drift-analyzer.js';
import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
  type CompanionMeV1,
  type CompanionValueV1,
  type CompanionMemoryV1,
  type CompanionGrowthV1,
  type ExplorationIntensityV1,
  type ExplorationDirectionV1,
} from '@chrono/contracts';
import type { CoreValue } from '@chrono/kernel';
import type { MemoryNode } from '@chrono/kernel';

/** 主页价值列表默认条数（按 weight 降序取 topN）。 */
const TOP_VALUES_LIMIT = 5;
/** 主页记忆列表默认条数（按 createdAt 降序取最近 N 条）。 */
const RECENT_MEMORIES_LIMIT = 10;

/* ── 纯映射函数（无副作用，便于单测） ─────────────────────────────── */

/** CoreValue → C 端价值视图（丢弃 timeDiscount/emotionAmplifier 等调参细节）。 */
export function toCompanionValue(v: CoreValue): CompanionValueV1 {
  return { id: v.id, label: v.label, weight: v.weight };
}

/** MemoryNode → C 端记忆摘要（只保留陪伴所需字段）。 */
export function toCompanionMemory(m: MemoryNode): CompanionMemoryV1 {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    valence: m.valence,
    salience: m.salience,
    createdAt: m.createdAt,
  };
}

/** 企业版 drift alertLevel → C 端探索强度（语义不变，只是不叫「告警」）。 */
function alertLevelToIntensity(level: DriftReport['alertLevel']): ExplorationIntensityV1 {
  switch (level) {
    case 'critical': return 'leaping';
    case 'warning': return 'exploring';
    default: return 'steady';
  }
}

/** 单条 ValueDrift → C 端探索方向（direction 由 delta 符号定，magnitude=|delta| 夹到 0..1）。 */
function valueDriftToDirection(d: ValueDrift): ExplorationDirectionV1 {
  const magnitude = Math.min(1, Math.abs(d.delta));
  const direction: ExplorationDirectionV1['direction'] =
    d.delta > 0 ? 'toward' : d.delta < 0 ? 'away' : 'steady';
  return {
    valueId: d.valueId,
    label: d.label,
    direction,
    magnitude,
    intensity: alertLevelToIntensity(d.alertLevel),
  };
}

/**
 * DriftReport → C 端成长视图。report 为 null（尚无基线快照）时返回「还在认识你」空态。
 * directions 按 magnitude 降序，让前端直接渲染「走得最远的方向」在最前。
 */
export function driftReportToGrowth(report: DriftReport | null): CompanionGrowthV1 {
  if (!report) {
    return {
      schemaVersion: 'companion-growth.v1',
      hasBaseline: false,
      analyzedAt: null,
      overallIntensity: 'steady',
      directions: [],
    };
  }
  const directions = report.valueDrifts
    .map(valueDriftToDirection)
    .sort((a, b) => b.magnitude - a.magnitude);
  return {
    schemaVersion: 'companion-growth.v1',
    hasBaseline: report.baselineSnapshotId !== null,
    analyzedAt: report.analyzedAt,
    overallIntensity: alertLevelToIntensity(report.alertLevel),
    directions,
  };
}

/* ── 路由注册 ──────────────────────────────────────────────────── */

export function registerCompanionRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  db: IDatabase,
  config: AppConfig,
): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /**
   * Plan 门控：companion 面向 C 端，enterprise 账号不应进入 companion UI（避免治理用户误入）。
   * 与 roadmap Phase 2.1「/api/v1/companion/* 要求账号 plan ≠ enterprise」一致。
   */
  function assertCompanionPlan(request: FastifyRequest): void {
    const user = request.user as JwtPayload | undefined;
    if (user?.planId === 'enterprise') {
      throw new AuthorizationError(
        'companion 接口面向个人版账号；enterprise 账号请使用企业控制台',
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      );
    }
  }

  const driftThresholdFallback = {
    warning: config.safety.drift.warningThreshold,
    critical: config.safety.drift.criticalThreshold,
  };

  /* GET /api/v1/companion/me —「我的数字人」主页 */
  app.get('/api/v1/companion/me', async (request) => {
    assertCompanionPlan(request);
    const core = getOS(request).core;

    const allValues = [...core.values.getAll().values()];
    const topValues = [...allValues]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, TOP_VALUES_LIMIT)
      .map(toCompanionValue);

    const allMemories = [...core.memories.getAllMemories().values()];
    const recentMemories = [...allMemories]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RECENT_MEMORIES_LIMIT)
      .map(toCompanionMemory);

    const payload: CompanionMeV1 = {
      schemaVersion: 'companion-me.v1',
      narrative: core.narrative.get(),
      topValues,
      recentMemories,
      valueCount: allValues.length,
      memoryCount: allMemories.length,
    };
    /* 序列化前用契约 schema 校验，确保后端输出与前端类型同源（漂移即测试失败）。 */
    return { data: CompanionMeV1Schema.parse(payload) };
  });

  /* GET /api/v1/companion/me/growth —「你最近探索的方向」（drift 的 C 端渲染） */
  app.get('/api/v1/companion/me/growth', async (request) => {
    assertCompanionPlan(request);
    const thresholds = resolveDriftThresholds(db, driftThresholdFallback);
    const analyzer = new PersonaDriftAnalyzer(db, thresholds);
    const report = analyzer.getLatest(request.tenantId);
    return { data: CompanionGrowthV1Schema.parse(driftReportToGrowth(report)) };
  });
}
