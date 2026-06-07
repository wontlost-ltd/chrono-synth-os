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
  CompanionMemoryListV1Schema,
  type CompanionMeV1,
  type CompanionValueV1,
  type CompanionMemoryV1,
  type CompanionGrowthV1,
  type CompanionMemoryListV1,
  type ExplorationIntensityV1,
  type ExplorationDirectionV1,
} from '@chrono/contracts';
import { MemoryFacade } from '../../../core/memory-facade.js';
import { parsePagination } from '../../plugins/pagination.js';
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
 * DriftReport → C 端成长视图。
 *
 * `hasBaseline` **不能**用 report.baselineSnapshotId !== null 判断：PersonaDriftAnalyzer 在
 * 只有 1 个快照时仍会持久化一份 baselineSnapshotId=该快照、valueDrifts=[] 的报告（那个
 * 快照是「当前」而非「历史基线」）。真正的基线需要 ≥2 个快照做对比，故由调用方传入
 * hasComparisonBaseline（快照数 ≥ 2）。report 为 null（从未分析）时一律空态。
 */
export function driftReportToGrowth(
  report: DriftReport | null,
  hasComparisonBaseline: boolean,
): CompanionGrowthV1 {
  if (!report || !hasComparisonBaseline) {
    return {
      schemaVersion: 'companion-growth.v1',
      hasBaseline: false,
      analyzedAt: report?.analyzedAt ?? null,
      overallIntensity: 'steady',
      directions: [],
    };
  }
  const directions = report.valueDrifts
    .map(valueDriftToDirection)
    .sort((a, b) => b.magnitude - a.magnitude);
  return {
    schemaVersion: 'companion-growth.v1',
    hasBaseline: true,
    analyzedAt: report.analyzedAt,
    overallIntensity: alertLevelToIntensity(report.alertLevel),
    directions,
  };
}

/** 统计租户快照数（与 PersonaDriftAnalyzer.analyze 的 WHERE 一致），用于判断是否有可对比基线。 */
export function countTenantSnapshots(db: IDatabase, tenantId: string): number {
  const row = db.prepare<{ n: number }>(
    `SELECT COUNT(*) AS n FROM snapshots
      WHERE tenant_id = ? OR (tenant_id IS NULL AND ? = 'default')`,
  ).get(tenantId, tenantId);
  return row?.n ?? 0;
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
   * Companion 访问门控（C 端专属）：
   *   1. 仅用户会话可用——拒绝 API-key 主体（apikey:* sub）。API-key 面向服务端集成/企业
   *      自动化，且静态 key 被强制 planId='free'（plugins/auth.ts），不应打开个人版 UI。
   *   2. enterprise plan 账号走企业控制台，不进 companion UI。
   * 与 roadmap Phase 2.1「/api/v1/companion/* 要求账号 plan ≠ enterprise」一致并收紧。
   *
   * 说明：plan 取自 JWT 的 planId，正常登录/刷新会嵌入当前订阅 plan。陈旧 token 的 plan
   * 时效性是平台级 token 策略问题（非本路由职责）；这里做显式的主体类型 + plan 双重拒绝。
   */
  function assertCompanionAccess(request: FastifyRequest): void {
    const user = request.user as JwtPayload | undefined;
    /* 主体类型门：API-key 主体（apikey:* sub）+ service 角色都不是个人用户会话。
     * 双重判定（sub 前缀 + role）避免未来某条 token 签发路径只满足其一时漏网。 */
    if (user?.sub?.startsWith('apikey:') || user?.role === 'service') {
      throw new AuthorizationError(
        'companion 接口仅支持个人用户会话，不支持 API Key / service 主体访问',
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      );
    }
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

  /* 记忆分页读取复用企业版 MemoryFacade（含 confidence 富集 + 租户隔离），C 端只做映射。 */
  const memoryFacade = new MemoryFacade(os, tenantFactory, config);

  /* GET /api/v1/companion/me —「我的数字人」主页 */
  app.get('/api/v1/companion/me', async (request) => {
    assertCompanionAccess(request);
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
    assertCompanionAccess(request);
    const thresholds = resolveDriftThresholds(db, driftThresholdFallback);
    const analyzer = new PersonaDriftAnalyzer(db, thresholds);
    const report = analyzer.getLatest(request.tenantId);
    /* ≥2 个快照才算有可对比的历史基线（单快照报告的 baselineSnapshotId 是「当前」快照）。 */
    const hasComparisonBaseline = countTenantSnapshots(db, request.tenantId) >= 2;
    return { data: CompanionGrowthV1Schema.parse(driftReportToGrowth(report, hasComparisonBaseline)) };
  });

  /* GET /api/v1/companion/me/memories —「我的记忆」分页浏览（复用 MemoryFacade.listMemories） */
  app.get('/api/v1/companion/me/memories', async (request) => {
    assertCompanionAccess(request);
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const result = memoryFacade.listMemories(request.tenantId, page, pageSize);
    /* MemoryNodeWithConfidence extends MemoryNode → toCompanionMemory 直接可用（多余字段丢弃）。 */
    const payload: CompanionMemoryListV1 = {
      schemaVersion: 'companion-memory-list.v1',
      items: result.data.map(toCompanionMemory),
      pagination: result.pagination,
    };
    return { data: CompanionMemoryListV1Schema.parse(payload) };
  });
}
