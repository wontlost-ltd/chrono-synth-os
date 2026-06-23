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
 * 一家真实小公司的组织图——一个 CEO（doer）领两条职能线，**岗位名与内置分解 playbook 的委派契约对齐**，
 * 故组织开箱即可承接全部三个 goalType（content_piece / data_analysis / support_ticket）。
 *
 *   ceo（doer）
 *   ├─ 内容与数据负责人（analyst）   ← 接 content_piece + data_analysis
 *   │    内容链 IC：researcher_ic / writer_ic / reviewer_ic / publisher_ic
 *   │    数据链 IC：analyst_lead_ic / data_eng_ic / analyst_ic / reporter_ic（reviewer_ic 两链共用）
 *   └─ 客服负责人（guardian）        ← 接 support_ticket
 *        客服链 IC：triage_ic / support_agent_ic / escalation_ic / qa_ic
 *
 * 为何两条线而非三条：content_piece 与 data_analysis 都需要 `reviewer_ic`，而 roleCode 全组织唯一 +
 * 委派只能给直接下属 + 一名 worker 只有一个上级——三者叠加使同名 reviewer_ic 不可能同时归两个不同 lead。
 * 故把内容与数据合并到同一负责人下（真实公司「内容与洞察」部门常如此），让 reviewer_ic 唯一且两链共用。
 *
 * 每条线内混合原型，覆盖全部 4 原型（explorer/guardian/analyst/doer），证明「同组织多个不同认知人格」。
 * personaId 与 roleCode 一一对应（实例身份）。岗位名（*_ic / *_lead_ic）即 playbook 的 assigneeRoleCode。
 */
function digitalOrgPod(): readonly WorkerPersonaSpec[] {
  return [
    /* 根：行动型 CEO。 */
    { roleCode: 'ceo', title: '首席执行官', jobFamily: 'exec', seniority: 'exec', displayName: '齐总', personaId: 'persona-ceo', managerRoleCode: null, archetype: 'doer' },

    /* ── 内容与数据线：分析型负责人（接 content_piece + data_analysis 两种目标）── */
    { roleCode: 'knowledge_lead', title: '内容与数据负责人', jobFamily: 'manager', seniority: 'lead', displayName: '析数姐', personaId: 'persona-knowledge-lead', managerRoleCode: 'ceo', archetype: 'analyst' },
    /* 内容链 IC（content_piece playbook 的 assigneeRoleCode）。 */
    { roleCode: 'researcher_ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: '小探', personaId: 'persona-researcher-ic', managerRoleCode: 'knowledge_lead', archetype: 'explorer' },
    { roleCode: 'writer_ic', title: '撰稿人', jobFamily: 'ic', seniority: 'ic', displayName: '小文', personaId: 'persona-writer-ic', managerRoleCode: 'knowledge_lead', archetype: 'explorer' },
    { roleCode: 'reviewer_ic', title: '审核员', jobFamily: 'ic', seniority: 'ic', displayName: '小守', personaId: 'persona-reviewer-ic', managerRoleCode: 'knowledge_lead', archetype: 'guardian' },
    { roleCode: 'publisher_ic', title: '发布助理', jobFamily: 'ic', seniority: 'ic', displayName: '小发', personaId: 'persona-publisher-ic', managerRoleCode: 'knowledge_lead', archetype: 'doer' },
    /* 数据链 IC（data_analysis playbook 的 assigneeRoleCode；reviewer_ic 与内容链共用）。 */
    { roleCode: 'analyst_lead_ic', title: '需求分析师', jobFamily: 'ic', seniority: 'ic', displayName: '小需', personaId: 'persona-analyst-lead-ic', managerRoleCode: 'knowledge_lead', archetype: 'analyst' },
    { roleCode: 'data_eng_ic', title: '数据工程师', jobFamily: 'ic', seniority: 'ic', displayName: '小数', personaId: 'persona-data-eng-ic', managerRoleCode: 'knowledge_lead', archetype: 'doer' },
    { roleCode: 'analyst_ic', title: '数据分析师', jobFamily: 'ic', seniority: 'ic', displayName: '小析', personaId: 'persona-analyst-ic', managerRoleCode: 'knowledge_lead', archetype: 'analyst' },
    { roleCode: 'reporter_ic', title: '报告撰写', jobFamily: 'ic', seniority: 'ic', displayName: '小报', personaId: 'persona-reporter-ic', managerRoleCode: 'knowledge_lead', archetype: 'explorer' },

    /* ── 客服线：守护型负责人（接 support_ticket 目标）── */
    { roleCode: 'support_lead', title: '客服负责人', jobFamily: 'manager', seniority: 'lead', displayName: '守质哥', personaId: 'persona-support-lead', managerRoleCode: 'ceo', archetype: 'guardian' },
    /* 客服链 IC（support_ticket playbook 的 assigneeRoleCode）。 */
    { roleCode: 'triage_ic', title: '分诊专员', jobFamily: 'ic', seniority: 'ic', displayName: '小诊', personaId: 'persona-triage-ic', managerRoleCode: 'support_lead', archetype: 'guardian' },
    { roleCode: 'support_agent_ic', title: '客服专员', jobFamily: 'ic', seniority: 'ic', displayName: '小服', personaId: 'persona-support-agent-ic', managerRoleCode: 'support_lead', archetype: 'doer' },
    { roleCode: 'escalation_ic', title: '升级专员', jobFamily: 'ic', seniority: 'ic', displayName: '小升', personaId: 'persona-escalation-ic', managerRoleCode: 'support_lead', archetype: 'guardian' },
    { roleCode: 'qa_ic', title: '质检专员', jobFamily: 'ic', seniority: 'ic', displayName: '小检', personaId: 'persona-qa-ic', managerRoleCode: 'support_lead', archetype: 'analyst' },
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
