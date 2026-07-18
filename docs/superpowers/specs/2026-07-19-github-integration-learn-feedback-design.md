# 数字人 GitHub 集成（接入 / 学习 / 反馈）设计

> 状态：第 2 轮修订（采纳 Codex 复审 64/100 退回，修 8 条契约层硬伤）。待用户审阅 → writing-plans。
> 日期：2026-07-19
> 关联 ADR：0047（零-LLM 内核 / LLM-as-teacher）、0051（感知层）、0055（数字员工执行链）、0060（工具学习三层分离）、0056（per-persona 内核）。

> **修订说明（第 2 轮，采纳 Codex 独立复审）**：初版基于探针摘要，多处契约与真实代码不符，已逐条核验真实代码后修正：
> ① `PerceptionInput` 只有 `audio|video` modality + 媒体专用字段（`mediaSha256`/`durationMs`），GitHub 文本套不进 → 引入独立的**文本/代码摄入契约**，不硬塞媒体 perception 形状。
> ② `PerceptionDistiller` 的 `validFacts` 直写 `memoryGraph.addMemory`（记忆无 provenance/信任字段），**只有身份/价值提议**过 `distillation.ingest`/`core-update-gate`。信任层封顶管的是**内核身份/价值**，不是普通记忆——初版把两者混为一谈，已厘清。
> ③ `outboundCommitment` 在 `ExecutionRiskSignals`（`execution-risk.ts`），**不在 `TaskSpec`**（TaskSpec 只有 `riskLevel: RiskLevel`）。改由 `tool-risk-deriver` 从**工具 metadata** 派生，不靠 TaskSpec 字段。
> ④ 私网 GHE 会被 `isPrivateAddress` 拒 → 明确 GHE 私网需显式 SSRF bypass 约定。
> ⑤ `user_oauth_tokens` 是**用户级** OAuth（有 `user_id` + access/refresh token）→ 改**新建租户级专用凭据表**（参照 `llm_provider_credentials` 的租户级加密模式，但适配 App 私钥/webhook secret/一对多 installation）。
> ⑥ `webhook_events` 表只有 `event_id(PK)/event_type/processed_at`，**无 provider 列** → GitHub 与 Stripe 事件 id 空间会撞，须加 `provider` 列（迁移）或独立幂等键空间。
> ⑧ 现有对外写工具（email/calendar）靠 `metadata.highRisk=true` + pipeline 强制确认 → GitHub 写方法必须注册为 `highRisk=true`，且**只能经审批 executor（ToolInvocationPipeline/WorkerExecutionService）持有**，connector 写方法不得被业务层直接调用（否则绕过审批）。

---

## 1. 目标（一句话）

让数字人能**接入 GitHub**（GitHub App 认证）、**从 GitHub 学习**（代码/README、issues、PR/review、commit 四类内容，经 perception 沉淀为确定性记忆；身份/价值影响经 core-update-gate 封顶）、并能对 GitHub **反馈**（webhook 事件驱动起草 issue/PR 评论与 code review，经**不可降级的人工审批门**后发布）——全程不破零-LLM 内核铁律。

## 2. 架构（方案 A：感知层单主干，第 2 轮修订）

三段一条主干：所有 GitHub 学习内容收敛为**文本表征**，走文本/代码摄入契约进 `PerceptionDistiller`，事实沉淀为记忆、身份/价值提议经 `core-update-gate` 强制封顶只能 `pending`（内核绝不因读 GitHub 自动改）；所有对 GitHub 的写动作注册为 `highRisk` 工具，经 `tool-risk-deriver` 派生 `outboundCommitment` 风险信号 → `assessExecutionRisk` 强制人工审批，自主流永远发不出去。

```
接:  GitHubConnector（App JWT→installation token 自动刷新 + SSRF allowlist + 限流）
       凭据:新建租户级 github_app_credentials 表（AES-256-GCM 加密 App 私钥/webhook secret）
            + installation 映射（一对多 repo/org→installation_id）

学:  GitHubLearningMapper（4 类内容→文本表征，保留关键结构）
       → PerceptionDistiller.perceive（文本/代码摄入契约，非媒体形状）
           · 事实 → memoryGraph.addMemory（如实沉淀，与现有感知事实同级）
           · 身份/价值提议 → distillation.ingest → core-update-gate 强制 pending 封顶
       → co_occurrence 边 → 零-LLM 对话可引用
       增量:github_learn_state 表（同步游标）

反馈:GitHub webhook（HMAC 签名校验 + 幂等，事件带 provider 键）→ 增量学
       → workforce 任务（delegated）→ GitHubResponseComposer 零-LLM 起草草稿
       →【outboundCommitment → assessExecutionRisk 强制 requiresHuman，不可降级】
       →【人工审批门 isExecutionApprovalCleared 绑定本次执行】
       → 写工具（highRisk，只经审批 executor 持有）→ GitHubConnector 写 → 审计留痕
```

**关键更正（对齐真实契约）**：信任层封顶只作用于**内核身份/价值**（core-update-gate），普通记忆如实沉淀（无 provenance 字段）；`outboundCommitment` 是**风险信号**（execution-risk），由工具 metadata 派生，非 TaskSpec 字段。

## 3. 技术栈

- Node.js + TypeScript（现有 src/ 结构）。
- 复用现有：`FieldEncryption`（AES-256-GCM，同 BYOK）、`llm_provider_credentials` 的租户级凭据模式（参照，不复用表）、`ssrf-guard`、`PerceptionDistiller`/`DistillationService`/`core-update-gate`、`memory-service.addMemory`、`deterministic-memory-association`、`WorkerExecutionService` + `ApprovalService` + `execution-risk` + `tool-risk-deriver`、`ToolRegistry`/`ToolInvocationPipeline`（写工具）、`PlaybookRegistry`、Stripe webhook 的 raw-body + 幂等模式。**不复用** `user_oauth_tokens`（用户级 OAuth，语义不符）。
- 新增：GitHub App JWT 签发（用 Node `crypto` 对 App 私钥签 RS256 JWT，不引重依赖；如需 `@octokit/*` 须在实现计划里论证并走标准化复用评估）。

## 4. 全局约束（Global Constraints，每个实现任务隐含遵守）

1. **零-LLM 内核铁律**：运行时（起草回应、对话引用）不得调用 LLM。LLM 仅作为 perception 的可选老师（BYOK，per-tenant 选择），其产出为**候选**，事实沉淀为记忆、身份/价值提议须过 core-update-gate。`GitHubResponseComposer` 是零-LLM 确定性编译器。
2. **内核封顶（非记忆信任档）**：GitHub 学习经 perception 时，**事实型观察如实写入记忆**（`memoryGraph.addMemory`，与现有 audio/video 感知事实同级，记忆本身无 provenance/信任字段）；**只有身份/价值提议**（value_shift/narrative_patch）过 `distillation.ingest` → `core-update-gate`，被感知封顶（对齐现有 `MAX_PERCEPTION_DELTA=0.05`、`patternAgrees=false`）→ 永远 `pending`，绝不自动改内核。**信任层（core-update-gate 的 trustTier）管的是内核身份/价值更新，不是普通记忆写入**——不得声称"记忆走 external 信任档"。
3. **反馈=不可降级人工审批**：GitHub 写工具在 registry 注册 `metadata.highRisk=true`；`tool-risk-deriver.deriveRiskSignals` 从工具 metadata 派生 `ExecutionRiskSignals.outboundCommitment=true`（**这是风险信号，非 TaskSpec 字段**）→ `assessExecutionRisk` 强制 `effectiveRisk:'high'` + `requiresHuman:true`，**代码路径上不可降级**。执行时用 `isExecutionApprovalCleared`（绑定本次执行），**不得**用裸 `isApprovalCleared`。
4. **人类法律主体永不为 null**：发布动作经 `resolveWorkerExecutionActor`，缺主体抛 `MissingHumanPrincipalError`。
5. **出站唯一出口**：所有 GitHub 网络调用只经 `GitHubConnector`；**GitHub 写方法（comment/review）只能经审批 executor（ToolInvocationPipeline / WorkerExecutionService）持有**，不得被业务层/webhook 处理器直接调用（否则绕过审批门）。每次调用过 `validateOutboundUrl(rawUrl, opts)`，`opts.hostAllowlist` 锁 `api.github.com`。
6. **凭据只存密文**：GitHub App 私钥 PEM + webhook secret 经 `FieldEncryption`（AES-256-GCM）加密落**新建的租户级凭据表**（参照 `llm_provider_credentials` 的 `tenant_id`+`provider`+密文列模式，**非** `user_oauth_tokens` 的用户级 OAuth 模型）；installation token 是短时派生物，只在内存缓存，不落库。
7. **SSRF host 约定**：公有云走 `api.github.com`（scheme 强制 https，`isPrivateAddress` 拒私网正常）；**GHE 私网自托管**（私有 IP）会被 `isPrivateAddress` 拒，须经**显式配置的 host allowlist bypass**（记录在配置 + 审计），不得默认放开私网。
8. **新表双登记**：任何新增租户级表（`github_learn_state`、`github_app_credentials`）必须同时登记进 `src/multi-tenant/tenant-database.ts` 的 `TENANT_TABLES` **和** `src/privacy/privacy-service.ts` 的 `TENANT_TABLES`/`TENANT_TABLE_SET`（GDPR export/erase；凭据表导出须脱敏不导密文列）。迁移须同步 schema-dsl 既有同步点（迁移文件/index/version-map/parity/legacy fixture 等）。
9. **per-persona scope**：学习与游标按 `(tenant_id, persona_id)` 隔离（延续 ADR-0056）。
10. **前置人工步骤（非代码）**：GitHub App 的注册（拿 App ID / 私钥 PEM / webhook secret）是外部人工步骤，代码无法自动完成——作为配置输入，像 BYOK 一样。

---

## 5. 组件设计

### 5.1 接入段：GitHubConnector

**文件（新建）**：
- `src/integrations/github/github-connector.ts` — 唯一网络出口（认证 + 出站 + 限流）。
- `src/integrations/github/github-auth-manager.ts` — App JWT 签发 + installation token 缓存/刷新。
- `src/integrations/github/github-api-client.ts` — 具体 REST 端点（读：repo tree / 文件 / issues / PRs / commits；写：issue comment / PR review）。

**GitHub App 三级认证链**：
1. **前置人工**：用户在 GitHub 注册 App，得 `App ID` + 私钥 PEM + webhook secret，填入配置/凭据库。
2. **App JWT**：`GitHubAuthManager` 用私钥签短时（≤10min）RS256 JWT，身份=App 本身。
3. **Installation token**：用 App JWT 换某 installation 的 token（有效期 ~1h），**内存缓存 + 到期前自动重签**，调用方无感。真正调 API 用它。

**凭据存储（新建租户级专用表，不复用 user_oauth_tokens）**：
- **更正（Codex ⑤）**：`user_oauth_tokens` 是**用户级** OAuth（`user_id` + access/refresh token + `access_expires_at`），语义不符租户级 App 私钥。改**新建 `github_app_credentials` 表**（见 6），参照 `llm_provider_credentials`（`packages/kernel/src/domain/enterprise/llm-credential-queries.ts`）的**租户级加密凭据**模式：`tenant_id` + 密文列，无 `user_id`。
- 存：**App ID、App 私钥 PEM（`FieldEncryption` 加密）、webhook secret（加密）**。installation 映射（一对多 repo/org→installation_id）单独一表 `github_installations`（或凭据表的 `config_json` 密文），因是一对多，不塞单密钥列。
- 加密复用 `FieldEncryption`（`src/storage/encryption.ts`，AES-256-GCM，与 BYOK 同）。
- installation token 不落库（约束 6）。

**出站安全（复用）**：
- 每次调用先 `validateOutboundUrl(rawUrl, opts)`（`src/security/ssrf-guard.ts`，真实签名 `(rawUrl, opts: SsrfGuardOptions)`），`opts.hostAllowlist=['api.github.com']`，`opts.allowedSchemes` 强制 https。
- **GHE 私网（约束 7）**：`isPrivateAddress` 会拒私网自托管 GHE；须经显式配置的 host allowlist bypass（配置项 + 审计），不默认放开。
- **DNS-pin 更正（Codex ④）**：`url-content-fetcher.ts` 现状**未做真正的 resolve-then-pin**（只有 `isPrivateHostname` 主机名判断）；若需 anti-rebinding，用 `ssrf-guard.ts` 的 `assertResolvedAddressSafe(ip)`（post-DNS-resolve）。GitHub API 走公有云、host 固定，rebinding 面小；GHE bypass 场景才需 pin——由实现计划按需接 `assertResolvedAddressSafe`，不臆造 fetcher 已有能力。大小上限 / 超时 / `redirect:'manual'` 复用 fetcher。
- 速率限制：读响应 `X-RateLimit-Remaining`，近枯竭时退避，不硬打 429。

**分层**：
```
GitHubConnector          唯一网络出口（读方法公开；写方法只经审批 executor 持有）
  ├─ GitHubAuthManager   App JWT + installation token 缓存/刷新
  ├─ GitHubApiClient     REST 端点（读/写）
  └─（复用）ssrf-guard + FieldEncryption + 新 github_app_credentials store
```

**可验证性**：真 public repo + 测试 App installation，`GitHubConnector.listIssues(repo)` 真拉到数据 = 接通证明。token 刷新用「强制缓存过期→下次调用应静默重签」测。

### 5.2 学习段：GitHubLearningMapper → perception 主干

**文件（新建）**：
- `src/perception/sources/github-perception-provider.ts` **或**扩 `PerceptionInput` 的摄入契约 — 见下「摄入契约更正」。
- `src/integrations/github/github-learning-mapper.ts` — 四类内容 → 文本表征映射（本段唯一新领域逻辑）。
- `src/server/routes/companion/learn-github.ts` — 手动学习端点 `POST /api/v1/companion/me/learn-github`（body: repo + 要学哪几类）。与现有 `learn-topic`（`src/server/routes/companion/me.ts`）同层，复用 companion 路由骨架。

**摄入契约更正（Codex ①，最关键）**：真实 `PerceptionInput`（`src/perception/perception-provider.ts`）只有 `modality: PerceptionModality`（`audio|video`）+ 媒体专用字段 `mediaSha256`/`durationMs` + `representation`。**GitHub 文本没有 mediaSha256/durationMs，套不进媒体形状**。两条修法（实现计划二选一，spec 层给判据）：
- **(推荐) 扩 `PerceptionModality` 加 `text`**，并把 `mediaSha256`/`durationMs` 改为**媒体专用可选字段**（text modality 时用内容 SHA 代替 mediaSha256 做 provenance/去重，durationMs 省略）。改动小、复用整条 perceive 管线，但**动了内核感知契约**（破坏性分析见 §5 破坏性）。
- **(备选) 学习不走 perceive，直接走确定性记忆写入 + core-update-gate**：GitHubLearningMapper 产出事实 → `memoryGraph.addMemory`；若有身份/价值提议 → 自行 `distillation.ingest`。绕开 PerceptionInput 媒体形状，但**重复 perceive 已封装的封顶/校验逻辑**（违 DRY）。
- **判据**：优先推荐项（扩 text modality），除非复审认为动内核契约风险过高。**learn-topic 现状怎么绕过的**须在实现计划里先核（它也喂 perceive，那它如何填 mediaSha256/durationMs？——这是实现计划 Task 0 必须先验证的既有事实，不臆断）。

**端点前缀约定（有意区分）**：手动学习走 `companion/me/*`（数字人主人发起的学习动作，与 learn-topic 同层）；系统入站 webhook 走 `integrations/github/*`（5.3，非用户动作、无 companion 身份、走签名校验）。两者鉴权与身份模型不同，故前缀不同。

**「关键文件」启发式**：`code` 类型不逐文件全拉，只拉 README + 顶层目录结构 + 少量入口/清单文件（如 package.json/pyproject.toml 等）。具体选择启发式在 writing-plans 阶段定义并测（避免大 repo 全量拉爆配额，见 9 风险表）。

**四类内容 → representation 映射**（保留关键结构，不压成散文）：

| 内容类型 | 拉取 | representation 模板 |
|---|---|---|
| 代码 + README/文档 | repo tree + 关键文件 | `关于「<repo>」我学到：这是一个 <lang> 项目，做 <README 摘要>。核心模块：<顶层目录/关键 symbol 列表>` |
| Issues + 讨论 | issues + comments | `关于「<repo> issue #N」我学到：<标题>。问题是 <正文摘要>。讨论结论：<comment 要点>` |
| PR + code review | PRs + review comments | `关于「<repo> PR #N」我学到：<标题>。改了 <files-changed 列表>。review 意见：<要点>` |
| Commit 历史 | commits | `关于「<repo> 演进」我学到：近期提交 <commit message 聚合>，演进方向是 <推导>` |

**治理主干（复用 perceive，修正记忆 vs 内核语义）**：
```
GitHubLearningMapper.map(githubContent) → 文本表征
  → PerceptionDistiller.perceive(<文本摄入契约>)
      ① PerceptionProvider.analyze()（可选 LLM 老师，BYOK，per-tenant；产出=候选）
      ② 硬校验 validFacts → 写 episodic/semantic 记忆（memoryGraph.addMemory）
                            —— 事实如实沉淀，与现有 audio/video 感知事实同级，
                               记忆本身无 provenance/信任字段（真实契约，见 memory-service.addMemory）
      ③ 身份/价值提议（value_shift/narrative_patch）→ distillation.ingest()
                            → core-update-gate 感知封顶（MAX_PERCEPTION_DELTA=0.05, patternAgrees=false）
                            → 永远 pending；不确定性预算超 → 降级 manual pending
      ④ linkMemoryAssociatively() → co_occurrence 边 → 零-LLM 对话可检索
```
**语义更正（Codex ②）**：信任层封顶（core-update-gate 的 trustTier）只作用于**②之外的③——内核身份/价值更新**；**普通记忆（②）如实写入，不存在"记忆走 external 信任档"**。数字人"记住了 GitHub 内容"是记忆层（可被对话引用）；"因 GitHub 改了自己的价值观"才是内核层（被封顶 pending）——两层分开。

**决策：走 perceive 而非 KnowledgeIngestionService**。`KnowledgeIngestionService` 直写记忆且**不产生身份/价值提议、不过 core-update-gate**；走 perceive 才让 GitHub 学习的**身份/价值影响**自动过内核封顶门。**不新建 `knowledge_sources` 的 `github` 类型**。（注：仅就"记忆写入"而言两者都直写；差别在 perceive 额外产出并封顶身份/价值提议。）

**增量与去重**：
- 新表 `github_learn_state`（见 6），记每个 `(tenant_id, persona_id, repo, resource_type)` 的同步游标：issue/PR 用 `updated_at`，commit 用 SHA，repo 用 tree SHA。
- 已学过且未变的跳过，只把新增/变更喂进 perception，避免同一 issue 反复灌记忆 + 重烧不确定性预算。

**触发**：手动（`learn-github` 端点）；自动（5.3 webhook 增量喂单条）。

**可验证性**：真拉一个 public repo → 学完 → 数字人零-LLM 对话能被问到「你从 X 学到什么」并 grounded 答出真实内容（记忆层）。内核封顶用「注入一条会诱导改价值观的 GitHub 内容 → 断言**内核身份/价值变更**落 pending 不自动生效」测（变异测试证非空跑：拿掉封顶后测试必须失败）。记忆写入本身不设信任门（如实沉淀），不测"记忆被拦"。

### 5.3 反馈段：webhook → 起草 → 人工审批 → 发布

**文件（新建）**：
- `src/server/routes/github-webhook.ts` — 入站 webhook 接收器（`POST /api/v1/integrations/github/webhook`）。
- `src/workforce/playbooks/github-issue-triage-playbook.ts`、`src/workforce/playbooks/github-pr-review-playbook.ts` — 两个 `DecompositionPlaybook`。
- `src/integrations/github/github-response-composer.ts` — 零-LLM 起草评论/review 草稿。

**端到端流**：
```
① GitHub webhook（新 issue / 新 PR）
    →【签名校验:X-Hub-Signature-256，HMAC-SHA256 + timingSafeEqual；失败直接拒】
    →【幂等:webhook_events 表，防 GitHub 重投】
② 增量学习（5.2）:把这条新 issue/PR 喂进 perception
③ 创建 workforce 任务（taskType:'github_issue_triage' | 'pr_review'）
    → status='delegated' + allowsToolExecution=true
④ GitHubResponseComposer 零-LLM 起草回应 → 存草稿，status 停在 delegated
    → 执行时 tool-risk-deriver 从写工具 metadata.highRisk 派生 outboundCommitment 信号
    →【assessExecutionRisk 强制 requiresHuman=true，不可降级】
⑤【人工审批门】用户看到草稿 → 批准 / 驳回
    → 批准后 isExecutionApprovalCleared（绑定本次执行）
⑥ WorkerExecutionService.execute() → 写工具（highRisk）→ GitHubConnector 写（POST comment / review）
⑦ 审计留痕（谁批的、发了什么、到哪个 issue/PR）
```

**Webhook 接收器**：复用 Stripe 模式（`src/server/routes/billing.ts` + `src/billing/stripe-webhook-service.ts`）——raw body + 签名头校验 + 幂等。GitHub 用 `X-Hub-Signature-256`（HMAC-SHA256，复用现有 `createHmac`+`timingSafeEqual` 助手，非 Stripe SDK）。**幂等键更正（Codex ⑥）**：真实 `webhook_events` 表只有 `event_id(PK)/event_type/processed_at`，**无 provider 列**——GitHub 与 Stripe 的 delivery id 空间会撞 PK。修法：迁移给 `webhook_events` 加 `provider` 列并改 PK 为 `(provider, event_id)`，**或**给 GitHub 用独立幂等表 `github_webhook_events`。实现计划二选一（加列改 PK 是破坏性迁移，需评估 Stripe 现有行；独立表更隔离）。签名校验失败直接拒，不进流程。

**两个 playbook**：注册进 `PlaybookRegistry`（`src/workforce/playbook-registry.ts`），产出 `TaskSpec`（真实字段：`assigneeRoleCode`、`title`、`taskType`、`riskLevel: RiskLevel`、`allowsToolExecution:true`、`acceptanceCriteria`、`requiredCapabilities`、可选 `slaMs`）。**更正（Codex ③）**：`outboundCommitment` **不是 TaskSpec 字段**——它是 `ExecutionRiskSignals`（`execution-risk.ts`），由 `tool-risk-deriver.deriveRiskSignals` 从**写工具的 metadata**（`highRisk`）在执行时派生。playbook 只需把任务标 `allowsToolExecution:true` + 用要求 GitHub 写工具的 `requiredCapabilities`；`outboundCommitment` 由工具 metadata 自动派生，playbook 不设该字段。

**GitHubResponseComposer（零-LLM）**：基于数字人已学记忆（5.2）+ issue/PR 上下文，拼评论/review 草稿。参照 `OfflineConversationResponder`（persona narrative + 检索记忆 → 文本）的模式，但产出「评论/review」结构而非聊天散文。零-LLM，与内核铁律一致。

**GitHub 写工具（新建，注册进 ToolRegistry）**：`github-comment-tool` / `github-review-tool`，`ToolAdapter.metadata.highRisk=true`（参照 email/calendar tool），`isHighRisk(args)` 恒 true。**只经 `ToolInvocationPipeline`/`WorkerExecutionService` 调用**，写方法不暴露给 webhook 处理器/业务层直调（约束 5）。

**治理红线（全部由现有机制强制）**：
- 写工具 `metadata.highRisk=true` → `tool-risk-deriver` 派生 `outboundCommitment` → `assessExecutionRisk` 强制 high + `requiresHuman:true` 不可降级（约束 3）。
- 执行时 `isExecutionApprovalCleared` 绑定本次执行（防「批 A 发 B」）。
- 人类法律主体永不为 null（约束 4）。
- 并发 CAS `delegated→in_progress`（防同一草稿双发）。
- 自主流永远只能起草：草稿停在 `delegated`，只有人工批准才 `→in_progress→执行`。
- webhook 处理器**不得**持有 connector 写方法引用（约束 5，防绕过审批直发）。

**可验证性**：
- webhook：正确签名 payload → 应创建任务起草；错误签名 → 应 401 拒绝。
- 审批门（最关键）：模拟「审批未清」→ 断言 `execute()` 拒绝发布；**变异测试**——把门拿掉后测试必须失败（证非空跑）。
- 绑定审批：批准任务 A 的执行 → 拿该批准去发任务 B → 应拒（`isExecutionApprovalCleared` 绑定校验）。

---

## 6. 数据模型

### 新表 1：`github_app_credentials`（租户级 App 凭据，Codex ⑤）

参照 `llm_provider_credentials` 的租户级加密模式（无 `user_id`）。

| 列 | 类型 | 说明 |
|---|---|---|
| tenant_id | TEXT PK 一部分 | 隔离键 |
| app_id | TEXT | GitHub App ID |
| private_key_encrypted | TEXT | App 私钥 PEM（FieldEncryption 密文，明文绝不落库） |
| webhook_secret_encrypted | TEXT | webhook secret（密文） |
| ghe_base_url | TEXT NULL | GHE 自托管 host（NULL=公有云 api.github.com） |
| created_by / created_at / updated_at | | |

**PK**：`(tenant_id)`（一租户一 App；如需多 App 再加 app slug）。导出脱敏不导密文列。

### 新表 2：`github_installations`（一对多 repo/org→installation）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| tenant_id | TEXT | 隔离键 |
| installation_id | TEXT | GitHub installation id |
| account | TEXT | org/user 登录名 |
| repos | TEXT | 覆盖的 repo 列表（JSON）或 `*`（全部） |
| created_at / updated_at | | |

**唯一约束**：`(tenant_id, installation_id)`。

### 新表 3：`github_learn_state`（增量同步游标）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| tenant_id | TEXT | 隔离键 |
| persona_id | TEXT | per-persona（ADR-0056） |
| repo | TEXT | `owner/name` |
| resource_type | TEXT | `code` \| `issues` \| `pulls` \| `commits`（CHECK 约束） |
| cursor | TEXT | 见下「游标语义」 |
| cursor_advanced_at | INTEGER | 游标**成功推进**时间戳（区别于 last_synced_at=最后尝试时间） |
| last_synced_at | INTEGER | 最后同步尝试时间戳 |
| created_at / updated_at | INTEGER | |

**唯一约束**：`(tenant_id, persona_id, repo, resource_type)`。

**游标语义（Codex ⑦，须明确避免漂移）**：
- `issues`/`pulls`：游标 = 已成功摄入的**最大 `updated_at`**；拉取用 GitHub `since=<cursor>` + 按 `updated_at asc` 分页；**游标只在一页全部成功摄入后才推进**（成功后 CAS 更新，失败不推进 → 下次重拉该页，幂等靠记忆去重）。并列 `updated_at` 用 `(updated_at, id)` 复合序防跳过。
- `commits`：游标 = 最后已摄入 commit 的 SHA（作 `since` 锚，非分页游标）；从锚**之后**拉。
- `code`：游标 = 已学的 tree SHA；tree SHA 变 → 重算关键文件差异；不变 → 跳过。
- **失败恢复**：任何一步失败，游标不推进（`cursor_advanced_at` 不更新），下次从旧游标重来；记忆写入幂等（内容 SHA 去重）保证重来不重复灌。

**三表双登记（约束 8，强制）**：均登记进 `tenant-database.ts` 的 `TENANT_TABLES` + `privacy-service.ts` 的 `TENANT_TABLES`/`TENANT_TABLE_SET`；`github_app_credentials` 导出脱敏。迁移经 schema-dsl 同步既有同步点。

### 复用表 / 迁移
- **`webhook_events`（Codex ⑥）**：现状 PK=`event_id` 无 provider 列 → GitHub 与 Stripe delivery id 会撞。修法二选一（实现计划定）：(a) 迁移加 `provider` 列 + PK 改 `(provider, event_id)`（破坏性，须迁移现有 Stripe 行）；(b) 新建独立 `github_webhook_events` 表（更隔离，推荐）。
- 记忆表（`persona_memories` 等，经 perceive 写入，复用）。
- **不复用** `user_oauth_tokens`（用户级 OAuth，语义不符——见新表 1）。

---

## 7. 前置人工步骤（spec 明确，代码不做）

1. 在 GitHub 注册一个 GitHub App，配置：读权限（Contents/Issues/Pull requests/Metadata）、写权限（Issues/Pull requests，用于反馈）、webhook（订阅 Issues/Pull requests 事件）。
2. 拿到 `App ID`、私钥 PEM、webhook secret。
3. 把 App 安装到目标组织/仓库，拿 installation。
4. 将 App ID / 私钥 / webhook secret / installation 映射填入配置（私钥经加密凭据库）。

---

## 8. 分片与可验证性（供 writing-plans 拆计划）

按段拆，每片自含、可独立验证：

- **Plan 0（前置核查）**：核 learn-topic 现状怎么喂 perceive（如何填 mediaSha256/durationMs）→ 定摄入契约修法（扩 text modality vs 走确定性记忆+gate，§5.2）。这决定 Plan 2 的地基，必须先做。
- **Plan 1（接）**：新 `github_app_credentials`/`github_installations` 表 + GitHubConnector + AuthManager + ApiClient（读端点）。验证：真拉 public repo；token 强制过期→静默重签。
- **Plan 2（学）**：GitHubLearningMapper + 摄入契约（按 Plan 0 定论）+ learn-github 端点 + github_learn_state 表 + 增量去重（成功才推进游标）。验证：学完可零-LLM 问答 grounded（记忆层）；**内核身份/价值封顶**变异测试。
- **Plan 3（反馈起草）**：github webhook 接收器（签名+幂等，provider 键）+ 两 playbook + GitHubResponseComposer。验证：签名正/误、起草停在 delegated。
- **Plan 4（反馈发布接线）**：github 写工具（highRisk，注册 ToolRegistry）+ 接 workforce 执行链，写方法只经审批 executor。验证：审批门变异测试、绑定审批测试、批准后真发到测试 repo（隔离环境）。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| GitHub 结构化数据压成 representation 损失结构 | 映射器针对性保留 symbol/files-changed/结论等关键结构（5.2 模板） |
| installation token 泄露面 | 只内存缓存不落库；私钥加密存储 |
| webhook 重投导致重复起草 | 幂等表（加 provider 键或独立 github_webhook_events，见 §6） |
| 大 repo 全量拉爆配额/预算 | 增量游标（成功才推进）+ 只喂变更 + X-RateLimit 退避 + 内核封顶不确定性预算 |
| 反馈误发（对外不可逆） | 不可降级人工审批门 + 绑定审批 + 并发 CAS + 写方法只经审批 executor（约束 3/4/5） |
| SSRF / 重定向逃逸 allowlist | ssrf-guard host allowlist + redirect:manual；GHE bypass 场景按需接 `assertResolvedAddressSafe` 做 anti-rebinding（fetcher 现状无真 DNS-pin） |
| 新表漏登记 GDPR/隔离 | 约束 8 三表双登记 + ratchet 测试强制 |
| GitHub 文本套不进媒体 PerceptionInput | 扩 text modality 或走确定性记忆+gate（§5.2 摄入契约更正，Task 0 先核 learn-topic 现状） |

## 10. 非目标（YAGNI）

- 不做通用「任意出站 HTTP 工具」（只做 GitHub 专用 Connector）。
- 不做 GitHub 之外的 SCM（GitLab/Bitbucket）——未来另立。
- 不做自动合并 PR / 自动关 issue 等高危写动作（首版只 comment/review）。
- 不做 GitHub App 的自动注册（前置人工步骤）。
