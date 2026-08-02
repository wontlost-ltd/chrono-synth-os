/**
 * github-learn handler 的**生产装配**（组合根调用的唯一入口）。
 *
 * 为什么独立成文件而非内联在 app.ts：装配要在 handler 闭包里按租户取 OS、造
 * PerceptionDistiller / GithubLearnStore / GitHubLearningService——这些都是持有
 * DB 载体的构造。内联在组合根会在那里堆出一批未登记的 DB sink 载体边（Plan 0
 * 的 sink 扫描器会如实报出来），而组合根本就不该承担领域装配职责。
 *
 * 收敛到本模块后：app.ts 只调一次 `createGithubLearnTaskHandlerForProduction(...)`，
 * 领域装配留在领域层。
 *
 * 安全不变量：装配与学习**都**用任务自带的 tenantId 取对应租户 OS，绝不用默认租户
 * ——否则会拿 A 的凭据去读、或把 B 的内容学进 A 的记忆。
 */

import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../../config/schema.js';
import type { TaskHandler } from '../../queue/task-worker.js';
import type { FieldEncryption } from '../../storage/encryption.js';
import { createGithubLearnTaskHandler } from './github-learn-task-handler.js';
import { assembleGitHubReadPort } from './github-readport-factory.js';
import { GitHubLearningService } from './github-learning-service.js';
import { GithubLearnStore } from '../../storage/github-learn-store.js';
import { PerceptionDistiller } from '../../perception/perception-distiller.js';
import { selectPerceptionProvider } from '../../server/routes/companion/perception-provider-factory.js';

/** companion 单 persona core-self 的 personaId（与 webhook / learn-github 端点一致）。 */
const COMPANION_PERSONA_ID = 'default';

export interface GithubLearnTaskWiringDeps {
  /** 基座 OS（default 租户，或无 tenantFactory 时的唯一 OS）。 */
  os: ChronoSynthOS;
  /** 多租户工厂；缺省则所有任务都走基座 OS。 */
  tenantFactory: TenantOSFactory | undefined;
  config: AppConfig;
  /** 凭据加密；未启用则装配恒失败（handler 会静默跳过）。 */
  encryption: FieldEncryption | undefined;
}

/**
 * 造生产用的 github-learn handler。webhook 入队的学习任务由它消费：
 * 按任务租户装配 ReadPort → 复用 GitHubLearningService.learn（内含讨论摄入、
 * digest 去重、演进式取代全部逻辑）。
 */
export function createGithubLearnTaskHandlerForProduction(
  deps: GithubLearnTaskWiringDeps,
): TaskHandler {
  /** 按租户取 OS——安全不变量的落点。 */
  const osFor = (tenantId: string): ChronoSynthOS =>
    deps.tenantFactory && tenantId !== 'default'
      ? deps.tenantFactory.getTenantOS(tenantId)
      : deps.os;

  return createGithubLearnTaskHandler({
    assemble: (tenantId) => {
      if (!deps.encryption) return { failure: 'no-credential' };
      const tenantOS = osFor(tenantId);
      return assembleGitHubReadPort(
        tenantOS.getDatabase(), deps.encryption, tenantId, () => tenantOS.getClock().now(),
      );
    },
    learn: async (tenantId, readPort, repo, resourceTypes) => {
      const tenantOS = osFor(tenantId);
      /* 感官老师按租户 BYOK 选（LLM 只在此摄取阶段被调，绝不进 runtime）。
       * 用本租户库读 BYOK 设置，保持租户隔离。 */
      const provider = selectPerceptionProvider(
        tenantId, tenantOS.getDatabase(), deps.config, deps.encryption,
      );
      const service = new GitHubLearningService({
        readPort,
        store: new GithubLearnStore(tenantOS.getDatabase(), tenantId),
        distiller: new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation),
        tenantId,
        personaId: COMPANION_PERSONA_ID,
        memories: tenantOS.core.memories,
      });
      await service.learn(repo, resourceTypes);
    },
    logger: deps.os.getLogger(),
  });
}
