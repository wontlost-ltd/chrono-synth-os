/**
 * 数字员工人格出生 service（K4，ADR-0056）——bootstrap 一个组织时，给每个 worker 创建**独立人格内核**
 * 并套**原型**（explorer/guardian/analyst/doer），让「一个组织里多个不同认知人格的数字员工」真正成立。
 *
 * 链路（确定性零-LLM）：
 *   1. orgChart.bootstrap 建组织结构（岗位/worker/汇报关系）；
 *   2. 对每个 worker：os.getCore(worker.personaId) 取**独立认知内核**（K3 工厂），写入该原型的**出生**
 *      决策风格(archetypeDecisionStyle) + 一句出生叙事——这是 persona 的「出生」（ADR 红线9：出生只由本
 *      显式流程做，core 工厂不自动 seed）；
 *   3. **幂等**：若该 persona 内核已有人格痕迹——decisionStyle row 存在 / cognitiveModel row 存在 /
 *      **叙事非空**——则**不覆盖**（ADR-0056：archetype 默认值不覆盖已存在 persona 的成长后状态）。
 *      只看决策风格不够：可能已写叙事/认知模型却无 decision_style row，会被误判新生而覆盖。
 *      （叙事判「非空内容」而非「row 存在」：空串叙事与未出生不可区分，按新生处理是正确语义。）
 *
 * 红线：零-LLM（archetypeDecisionStyle 是确定性模板）；persona 出生显式幂等；archetype 是模板、personaId
 * 是实例身份（一个 archetype 可多个实例）。
 */

import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { OrgChartService, WorkerSpec, BootstrapResult } from './org-chart-service.js';
import { archetypeDecisionStyle, type PersonalityArchetype } from '@chrono/kernel';

/** worker 出生规格 = 组织结构规格 + 原型。 */
export interface WorkerPersonaSpec extends WorkerSpec {
  /** 该 worker 的人格原型（出生基准决策风格）。 */
  readonly archetype: PersonalityArchetype;
}

/** 一个 worker 的出生结局。 */
export interface PersonaBirthOutcome {
  readonly personaId: string;
  readonly roleCode: string;
  readonly archetype: PersonalityArchetype;
  /** seeded=首次出生写入；skipped_existing=已有成长状态，未覆盖（幂等）。 */
  readonly kind: 'seeded' | 'skipped_existing';
}

/** bootstrap 结果：组织结构 + 每 worker 出生结局。 */
export interface WorkforceBootstrapResult {
  readonly chart: BootstrapResult;
  readonly births: readonly PersonaBirthOutcome[];
}

export class WorkforcePersonaBootstrapService {
  constructor(
    private readonly os: ChronoSynthOS,
    private readonly orgChart: OrgChartService,
    private readonly now: () => number,
  ) {}

  /**
   * bootstrap 一个组织 + 给每 worker 出生独立人格内核（套原型）。确定性、幂等、**原子**。
   * 整个流程（组织结构 + 全部人格出生）包在单个 DB 事务里：结构非法/任一出生写入失败 → 整体回滚，
   * 不留半成品组织、不留半出生人格（D 原子性）。
   */
  bootstrap(orgId: string, specs: readonly WorkerPersonaSpec[]): WorkforceBootstrapResult {
    return this.os.getDatabase().transaction(() => {
      /* ① 组织结构（orgChart 内部校验无环/单根/上级存在；非法抛错 → 事务回滚，不进人格出生）。 */
      const chart = this.orgChart.bootstrap(orgId, specs);

      /* ② 逐 worker 出生独立人格内核（K3 工厂取独立 core；幂等不覆盖已成长状态）。 */
      const births: PersonaBirthOutcome[] = [];
      for (const spec of specs) {
        const core = this.os.getCore(spec.personaId);
        const base = { personaId: spec.personaId, roleCode: spec.roleCode, archetype: spec.archetype } as const;
        /* 幂等：该 persona 内核已有人格痕迹 → 不覆盖（保护已成长人格）。
         * 只看 decisionStyle.exists() 不够：某 persona 可能已写 narrative/cognitiveModel 却无 decision_style row，
         * 仍会被误判新生而覆盖叙事（与 PR #159 出生扰动同构的坑）。故检查本片已 persona 隔离的三张人格特征表
         * (decisionStyle/cognitiveModel/narrative)。decisionStyle/cognitiveModel 判 row 存在；narrative 判**内容
         * 非空**（空串叙事与未出生不可区分，按新生处理是正确语义）。**不**查 values/memories/survival——它们在
         * CoreRhythmLayer 仍是 tenant 级、尚未 persona-aware，全核心检查会误伤同租户其他 persona 共享的状态。 */
        if (core.decisionStyle.exists() || core.cognitiveModel.exists() || core.narrative.get().trim() !== '') {
          births.push({ ...base, kind: 'skipped_existing' });
          continue;
        }
        /* 出生：写原型决策风格 + 一句出生叙事（确定性）。 */
        const now = this.now();
        core.decisionStyle.set(archetypeDecisionStyle(spec.archetype, now));
        core.narrative.set(this.birthNarrative(spec));
        births.push({ ...base, kind: 'seeded' });
      }
      return { chart, births };
    });
  }

  /** 确定性出生叙事（不调 LLM，按原型 + 岗位生成稳定文案）。 */
  private birthNarrative(spec: WorkerPersonaSpec): string {
    const archLabel: Record<PersonalityArchetype, string> = {
      explorer: '探索者', guardian: '守护者', analyst: '分析师', doer: '行动者',
    };
    return `我是${spec.displayName}，一名${archLabel[spec.archetype]}型的${spec.title}。`;
  }
}
