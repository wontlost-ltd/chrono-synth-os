#!/usr/bin/env node
/**
 * 数字员工组织生产 seed（ADR-0056 K6）——一条命令把一个**完整的多原型数字员工组织**落进运行库。
 *
 * 这是「一键 podman 部署完整组织」的 seed 步骤：连同 server 用的同一个库（createDatabase(loadConfig())
 * 自动迁移），用 K4 的 WorkforcePersonaBootstrapService 建一个真实小公司——7 名数字员工，覆盖全部 4 种人格
 * 原型（explorer/guardian/analyst/doer），各有**独立认知内核**（K3 工厂）+ 各自原型的出生决策风格/叙事。
 * server 进程读同一个库，seed 完即可在 companion / workforce API 看到这些不同人格的数字员工。
 *
 * 特性（全部继承 K1-K5）：
 *   - 零-LLM：出生只用确定性 archetypeDecisionStyle 模板；
 *   - 幂等：再次运行不覆盖已成长的人格（K4 skipped_existing）——可安全重跑；
 *   - 原子：组织结构 + 全部人格出生包在单 DB 事务，失败整体回滚（K4）；
 *   - per-persona：每名员工的自成长（earning/perception/reflection 蒸馏）落它自己的内核（K5）。
 *
 * 用法：
 *   CHRONO_DB_DRIVER=sqlite CHRONO_DB_PATH=/app/data/chrono.db node dist/scripts/seed-org.js
 *   # 自定义组织/租户：
 *   CHRONO_SEED_ORG_ID=acme CHRONO_SEED_TENANT_ID=default node dist/scripts/seed-org.js
 *
 * 退出码：0 成功（含「已存在，跳过」）；非 0 失败（结构非法/库错误，已整体回滚）。
 */

import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/storage/index.js';
import { ChronoSynthOS } from '../src/chrono-synth-os.js';
import { OrgWorkforceStore } from '../src/storage/org-workforce-store.js';
import { OrgChartService } from '../src/workforce/org-chart-service.js';
import {
  WorkforcePersonaBootstrapService,
  type WorkerPersonaSpec,
} from '../src/workforce/workforce-persona-bootstrap-service.js';
import { ConsoleLogger } from '../src/utils/logger.js';
import { realClock } from '../src/utils/clock.js';

/**
 * 一家真实小公司的组织图——一个 CEO（doer）领三条线：研究（explorer）、质量（guardian）、数据（analyst），
 * 每条线再带一名 IC。覆盖全部 4 原型，证明「同组织多个不同认知人格」。personaId 与 roleCode 一一对应（实例身份）。
 */
function digitalOrgPod(): readonly WorkerPersonaSpec[] {
  return [
    /* 根：行动型 CEO。 */
    { roleCode: 'ceo', title: '首席执行官', jobFamily: 'exec', seniority: 'exec', displayName: '齐总', personaId: 'persona-ceo', managerRoleCode: null, archetype: 'doer' },
    /* 研究线：探索型负责人 + IC。 */
    { roleCode: 'head-research', title: '研究负责人', jobFamily: 'manager', seniority: 'lead', displayName: '探研姐', personaId: 'persona-head-research', managerRoleCode: 'ceo', archetype: 'explorer' },
    { roleCode: 'researcher', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: '小探', personaId: 'persona-researcher', managerRoleCode: 'head-research', archetype: 'explorer' },
    /* 质量线：守护型负责人 + IC。 */
    { roleCode: 'head-quality', title: '质量负责人', jobFamily: 'manager', seniority: 'lead', displayName: '守质哥', personaId: 'persona-head-quality', managerRoleCode: 'ceo', archetype: 'guardian' },
    { roleCode: 'reviewer', title: '审核员', jobFamily: 'ic', seniority: 'ic', displayName: '小守', personaId: 'persona-reviewer', managerRoleCode: 'head-quality', archetype: 'guardian' },
    /* 数据线：分析型负责人 + IC。 */
    { roleCode: 'head-data', title: '数据负责人', jobFamily: 'manager', seniority: 'lead', displayName: '析数姐', personaId: 'persona-head-data', managerRoleCode: 'ceo', archetype: 'analyst' },
    { roleCode: 'analyst', title: '数据分析师', jobFamily: 'ic', seniority: 'ic', displayName: '小析', personaId: 'persona-analyst', managerRoleCode: 'head-data', archetype: 'analyst' },
  ];
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');
  const orgId = process.env.CHRONO_SEED_ORG_ID ?? 'chrono-digital-org';
  const tenantId = process.env.CHRONO_SEED_TENANT_ID ?? 'default';

  /* 连同 server 用的同一个库；createDatabase 自动跑迁移（与 main.ts 一致）。 */
  const db = createDatabase(config);
  const os = new ChronoSynthOS({ db, logger, tenantId, skipMigrations: true });
  os.start();

  try {
    const store = new OrgWorkforceStore(db, tenantId);
    const orgChart = new OrgChartService(store, () => realClock.now());
    const svc = new WorkforcePersonaBootstrapService(os, orgChart, () => realClock.now());

    const pod = digitalOrgPod();
    logger.info('SeedOrg', `开始 seed 数字员工组织：org=${orgId} tenant=${tenantId} 员工数=${pod.length}`);

    const result = svc.bootstrap(orgId, pod);

    /* 完整性校验（Codex K6 复审）：bootstrapIfAbsent 仅按「组织是否已有 worker」整体判定复用，若卷里残留
     * 同 orgId 的**半成品**结构（部分 worker），会复用该不完整 chart 却仍给 7 个 persona 出生 → 可能 exit 0
     * 但组织 chart 不全。故这里精确校验 chart 覆盖 pod 全部 roleCode，不满足即失败退出（不静默假成功）。 */
    const missing = pod.map((s) => s.roleCode).filter((rc) => !result.chart.workerIdByRole.has(rc));
    if (missing.length > 0) {
      throw new Error(`组织 chart 不完整（可能卷里残留同 orgId 半成品组织）：缺角色 ${missing.join(', ')}。请先 down -v 清卷再 seed。`);
    }

    const seeded = result.births.filter((b) => b.kind === 'seeded').length;
    const skipped = result.births.filter((b) => b.kind === 'skipped_existing').length;
    logger.info('SeedOrg', `组织已建：${result.chart.workerIdByRole.size} 名数字员工（出生 ${seeded}，已存在跳过 ${skipped}）`);

    /* 打印每名员工的原型与出生结局，便于人工核对「多个不同数字人格」。 */
    for (const b of result.births) {
      logger.info('SeedOrg', `  · ${b.roleCode} [${b.archetype}] persona=${b.personaId} → ${b.kind}`);
    }

    /* 原型多样性自检：4 原型都到齐才算「不同数字人格」真正成立。 */
    const archetypes = new Set(result.births.map((b) => b.archetype));
    if (archetypes.size < 4) {
      throw new Error(`原型多样性不足：仅 ${archetypes.size}/4 种（${[...archetypes].join(',')}）`);
    }
    logger.info('SeedOrg', `✓ 原型多样性达成：${[...archetypes].sort().join(' / ')}（4/4）`);
    logger.info('SeedOrg', '✓ seed 完成——server 已可在 workforce / companion API 看到这些不同人格的数字员工。');
  } finally {
    os.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    /* 失败：组织/人格已随 K4 单事务整体回滚，不留半成品。 */
    process.stderr.write(`[SeedOrg] seed 失败（已整体回滚）：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
