# GitHub 组织级驻留设计（仓库枚举 + 定时同步 worker）

**日期**: 2026-08-02
**状态**: 设计定稿，待实施
**关联**: GitHub 集成 Plan 2（学习）、[讨论内容摄入设计](2026-08-02-github-discussion-ingestion-design.md)、ADR-0047（LLM 当老师）

---

## 1. 问题陈述

数字人现在能学到 GitHub 上的真知识（讨论内容摄入已补齐），但**学不了整个组织，也不会自己学**。

三个具体障碍：

**① 只能学单个 repo。**`GitHubLearningService.learn(repo, resourceTypes)` 收单个 repo 字符串；`GitHubReadPort` 全部方法签名都是 `(repo: string, ...)`，URL 一律 `/repos/{repo}/...`。全仓搜不到 `/installation/repositories` 或 `/orgs/{org}/repos` 任何枚举调用。一个 50 仓库的组织，今天要发 50 次请求、手写 50 个仓库名。

**② 没有任何定时器。**全仓 20 个 `setInterval` worker 里没有 GitHub 的。学习只在人工 `POST /api/v1/companion/me/learn-github` 时发生一次。

**③ 「驻留」诉求因此不成立。**当前形态准确描述是：*人工指着一个 repo，快照式学一遍*。装好 App 之后它不会自己做任何事。

### 本设计不解决的问题（明确划界）

- **webhook 接学习管线**——`github-webhook.ts` 现在只起草回复、不调 `GitHubLearningService`，且只认 `action === 'opened'`。这是低延迟路径，属**下一个 spec**。
- **安装入口产品化**——目前仍靠一次性脚本 `scripts/connect-github.ts`，无 App 安装回调、无管理端点。
- **跨租户 worker**——本设计的 worker 是单租户作用域（跟随宿主 OS 实例）。
- **新表**——本设计不建新表（但需一条扩 CHECK 的迁移，见 §3.2）。

---

## 2. 设计目标

1. 一次调用能学完一个 installation 授权范围内的全部仓库
2. 装好 App 之后无需人工干预，持续自动学习
3. **单轮成本恒定可预测**，不随组织规模膨胀，不触发 GitHub 二级速率限制
4. 对现有部署零行为突变（默认关闭）
5. 零-LLM 铁律与内核封顶不破

---

## 3. 架构

三层改动，**不新增表**（一条迁移仅扩既有 CHECK 约束，见 §3.2）。

### 3.1 ReadPort：组织仓库枚举

`GitHubReadPort` 接口新增：

```ts
/** 列出本 installation 被授权访问的全部仓库全名（owner/name）。 */
listInstallationRepos(): Promise<string[]>;
```

端点：`GET /installation/repositories`。

为什么用它而不是 `/orgs/{org}/repos`：该端点返回的**正是这个 installation 被授权的仓库集**，天然等于「组织授权边界」——不用猜组织名，也不可能越权读到未授权仓库。

实现注意：该端点响应体是 `{total_count, repositories: [...]}` 而非裸数组，与既有 list 端点形状不同，分页合并时需从每页的 `repositories` 字段取值。复用既有 `fetchAllPages` 分页跟随与 `githubFetch` SSRF 网关。

只读契约不破（`list` 前缀只读方法），但须在 `github-read-port.test.ts` 的 `readMethods` 显式白名单登记。

### 3.2 Service：`learnOrg()` 轮转编排

新增方法：

```ts
learnOrg(orgKey: string, resourceTypes: GitHubResourceType[], maxReposPerRun: number): Promise<LearnOrgResult>
```

**轮转推进（限速核心）**：每轮只处理 `maxReposPerRun` 个仓库（默认 5），用一条**组织级游标**记住上次停在哪，下轮从下一个继续，绕完一圈回到开头：

```
组织 50 repo，每轮 5 个
轮1: repo[0..4]   → 游标 5
轮2: repo[5..9]   → 游标 10
...
轮10: repo[45..49] → 游标 0（回绕）
```

**单轮成本恒定**，与组织规模无关；大组织只是轮完一周周期更长。回绕后靠既有 per-repo 增量游标（`github_learn_state`）+ digest 摄入账本，未变化的内容自然全部 skip，不重复灌记忆。

**组织游标存储**：复用 `github_learn_state` 表——`repo` 字段存组织标识、`resource_type` 存哨兵值 `_org_rotation`、`cursor` 存下一个起始下标。该表唯一约束 `(tenant_id, persona_id, repo, resource_type)` 使每个组织一行，天然隔离。

**已实测确认**：该表 `resource_type` 有 CHECK 约束锁死 `('code','issues','pulls','commits')`，哨兵值写入被拒（实测报错 `CHECK constraint failed`）。故需**迁移 v126 扩 CHECK** 加入 `'_org_rotation'`。

选择理由：轮转游标本质就是一种「学习进度游标」，属 `github_learn_state` 的固有职责。另一条零迁移路径（借用 `github_ingest_digests`，该表 `resource_type` 无 CHECK，已实测可写）虽省迁移，但把「摄入幂等账本」当游标表用属语义错位，后人读起来困惑，不取。

**迁移实施注意**：SQLite 不能 `ALTER` CHECK 约束，须重建表。重建必踩既有已知坑——`RENAME` 后同名索引随 `_old` 挪走但仍占用全局索引名，导致后续 `CREATE INDEX IF NOT EXISTS` 静默 no-op、`DROP _old` 时连带删掉唯一那份索引。**修法：RENAME 后先 `DROP INDEX IF EXISTS` 再建**（照抄 v122 的手法与注释）。PG 走原地 `DROP CONSTRAINT` + `ADD CONSTRAINT`。

**重建后必须独立验证索引真实存在**（`PRAGMA index_list` 直接内省），不能只靠 parity 测试——parity 的 legacy fixture 可能从同样 buggy 的迁移手抄，两库同错仍 deepEqual 通过。

**失败隔离**：单个 repo 学习抛错 → 捕获、计入 `failedRepos`、继续下一个，不中断整轮。与既有「一类 resourceType 失败不影响其它类」的隔离风格一致。

**游标推进语义**：无论本轮各 repo 成功与否，组织游标都推进——否则一个持续失败的 repo 会永久卡住整个组织的轮转。已成功摄入的内容靠 digest 账本保证不重复。

### 3.3 `GithubSyncWorker`：定时驱动

新建 `src/integrations/github/github-sync-worker.ts`，骨架照搬 `src/workforce/learning-worker.ts`：`setInterval` + `running` 重入守卫 + `timer.unref()` + `start()/stop()/isHealthy()/driveOnce()`。

挂进 `ChronoSynthOS`，跟随宿主 OS 的租户作用域，与 `LearningWorker`、`TaskWakeReconcilerWorker` 完全同构——零新架构概念。

**默认关闭**（`enabled: false`）。理由：这是一条会自动发出站请求、自动消耗 LLM 老师额度的后台循环，默认开启对现有部署构成行为突变。必须显式开启。

**未连 GitHub 的租户**：每轮发现无 App 凭据/无 installation → 直接返回，零成本空转，不报错刷日志。

**默认周期**：30 分钟（组织知识沉淀非实时告警，无需高频；配合每轮 5 个仓库，50 仓库组织约 5 小时轮完一周）。

---

## 4. 数据流

```
GithubSyncWorker 每 30 分钟触发
  → 检查 App 凭据 + installation（缺 → 静默返回）
  → 装配 ReadPort（复用 learn-github 端点同款装配逻辑）
  → listInstallationRepos()                    [组织授权边界]
  → 读组织轮转游标（github_learn_state 哨兵行）
  → 取 repos[cursor .. cursor+5]               [单轮成本恒定]
  → 逐个 learn(repo, resourceTypes)            [复用既有全部逻辑]
      · 增量游标只覆盖有更新的条目
      · 评论数为 0 跳过不发请求
      · digest 账本防重复摄入
      · 演进式取代保证每 issue 恒为最新共识
  → 推进组织游标（含回绕）
```

---

## 5. 组件边界

| 组件 | 职责 | 依赖 |
|---|---|---|
| `listInstallationRepos` | 枚举授权仓库 | githubFetch（SSRF 网关）、auth |
| `learnOrg` | 轮转选片 + 逐 repo 编排 + 失败隔离 | ReadPort、GithubLearnStore、既有 `learn()` |
| `GithubSyncWorker` | 周期触发 + 重入守卫 + 生命周期 | Service 装配器、Logger |
| ReadPort 装配 | 从租户凭据造 ReadPort | GithubAppCredentialStore、installation 表 |

ReadPort 装配逻辑当前重复存在于三处（`learn-github.ts:148`、`draft-github-reply.ts:152`、`app.ts:693`）。worker 需要第四份。**实施时应抽出共享装配函数**，避免第四次复制——这是本次改动范围内的正当整理，不属无关重构。

---

## 6. 测试策略

### 迁移测试
- **索引内省断言**：v126 重建 `github_learn_state` 后，`PRAGMA index_list` 直验 `idx_github_learn_state_key` 唯一索引真实存在（防重建静默丢索引）
- 哨兵值 `_org_rotation` 可写入（扩 CHECK 生效）
- 既有四个 resource_type 仍可写入（CHECK 是超集，无回归）
- 重建后旧游标数据完整保留

### 单元测试
- `listInstallationRepos`：`{repositories:[...]}` 解包、分页跟随、空结果
- 轮转推进：12 个 repo / 每轮 5 → 三轮游标 5→10→0（回绕），各轮学到的 repo 集合正确
- 单 repo 失败不中断整轮（`failedRepos` 计数正确，其余 repo 仍学）
- 游标在有失败时仍推进（不卡死）
- worker：重入守卫（上轮未完不叠加）、`enabled:false` 不启动、无凭据静默返回
- 只读契约反射断言（新方法登记白名单后仍通过）

### 集成测试
- `learnOrg` 端到端：两轮分别学到不同 repo 的内容，记忆真沉淀

### 回归测试
- 既有 7 个 `github-learn-e2e` 测试全绿
- **内核封顶变异测试仍有效**：翻转 `patternAgrees` false→true 则测试转红

---

## 7. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| SQLite 重建表静默丢二级索引（改 CHECK 必踩） | **中** | RENAME 后先 `DROP INDEX IF EXISTS` 再建（照 v122）；**独立 `PRAGMA index_list` 内省断言**，不依赖 parity（fixture 可能同错） |
| 迁移 6 处同步点漏一处致 CI 红 | 中 | 严格走 checklist；含 parity 覆盖列表与 VERSION_MAP range 两处 test 断言；merge 前跑 `test:golden` 全门 |
| worker 持续消耗 LLM 老师额度 | 中 | 默认关闭 + 每轮 repo 上限；**明确告知：开启 worker = 开启一条持续消耗 LLM 额度的后台流** |
| 轮转延迟：大组织新 issue 最坏等一整圈 | 低（已接受） | 低延迟路径靠 webhook，属下一个 spec |
| GitHub 二级速率限制 | 低 | 每轮 repo 上限使单轮请求数恒定可预测 |
| 第四份 ReadPort 装配重复 | 低 | 抽共享装配函数（§5） |

---

## 8. 验收标准

1. `listInstallationRepos()` 能枚举出 installation 授权的全部仓库
2. `learnOrg()` 单轮只处理上限个仓库，游标正确推进并回绕
3. 单个 repo 失败不中断整轮，游标仍推进
4. worker 默认关闭；显式开启后周期触发，无凭据租户静默空转
5. `npm run test:golden` 全门通过
6. 内核封顶变异测试仍然有效
