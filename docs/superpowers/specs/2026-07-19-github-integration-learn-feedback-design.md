# 数字人 GitHub 集成（接入 / 学习 / 反馈）设计

> 状态：设计已确认（brainstorming 完成），待 Codex 独立复审 + 用户审阅 → writing-plans。
> 日期：2026-07-19
> 关联 ADR：0047（零-LLM 内核 / LLM-as-teacher）、0051（感知层）、0055（数字员工执行链）、0060（工具学习三层分离）、0056（per-persona 内核）。

---

## 1. 目标（一句话）

让数字人能**接入 GitHub**（GitHub App 认证）、**从 GitHub 学习**（代码/README、issues、PR/review、commit 四类内容，走感知层蒸馏门进确定性记忆）、并能对 GitHub **反馈**（webhook 事件驱动起草 issue/PR 评论与 code review，经**不可降级的人工审批门**后发布）——全程不破零-LLM 内核铁律。

## 2. 架构（方案 A：感知层单主干）

三段一条主干，所有 GitHub 学习内容都收敛为 `representation` 文本，走**唯一**的 `PerceptionDistiller.perceive()` 治理门，自动继承信任层 `external` 最严档 + 不确定性预算 + 蒸馏门；所有对 GitHub 的写动作都是 `outboundCommitment`，强制人工审批，自主流永远发不出去。

```
接:  GitHubConnector（App JWT→installation token 自动刷新 + SSRF allowlist + 限流）
       凭据:UserOauthTokenService 扩 github provider（AES-256-GCM 加密 App 私钥）

学:  GitHubLearningMapper（4 类内容→representation，保留关键结构）
       → PerceptionDistiller.perceive（external 信任档 + 不确定性预算 + 蒸馏门）
       → 记忆 + co_occurrence 边 → 零-LLM 对话可引用
       增量:github_learn_state 表（同步游标）

反馈:GitHub webhook（HMAC 签名校验 + 幂等）→ 增量学 → workforce 任务（delegated）
       → GitHubResponseComposer 零-LLM 起草草稿 →【人工审批门·不可降级】
       → GitHubConnector 写（comment / review）→ 审计留痕
```

## 3. 技术栈

- Node.js + TypeScript（现有 src/ 结构）。
- 复用现有：`FieldEncryption`（AES-256-GCM）、`UserOauthTokenService`、`ssrf-guard`、`PerceptionDistiller`、`DistillationService`、`core-update-gate`（信任层）、`deterministic-memory-association`、`WorkerExecutionService` + `ApprovalService` + `execution-risk`、`PlaybookRegistry`、Stripe webhook 的 raw-body + 幂等模式。
- 新增：GitHub App JWT 签发（用 Node `crypto` 对 App 私钥签 RS256 JWT，不引重依赖；如需 `@octokit/*` 须在实现计划里论证并走标准化复用评估）。

## 4. 全局约束（Global Constraints，每个实现任务隐含遵守）

1. **零-LLM 内核铁律**：运行时（起草回应、对话引用）不得调用 LLM。LLM 仅作为 perception 的可选老师（BYOK，per-tenant 选择），其产出必须过蒸馏门。`GitHubResponseComposer` 是零-LLM 确定性编译器。
2. **信任层最严档**：所有 GitHub 学习内容 `source:'perception'` → `external` 档（`trustTierConfidenceMultiplier=1.25` 最高门槛）。身份/价值提议强制封顶（`MAX_PERCEPTION_DELTA=0.05`、`patternAgrees=false`）→ 永远 `pending`，绝不自动改内核。
3. **反馈=不可降级人工审批**：任何对 GitHub 的写动作（comment/review）经 `assessExecutionRisk` 判定 `outboundCommitment` → 强制 `effectiveRisk:'high'` + `requiresHuman:true`，**代码路径上不可降级**。执行时用 `isExecutionApprovalCleared`（绑定本次执行），**不得**用裸 `isApprovalCleared`。
4. **人类法律主体永不为 null**：发布动作经 `resolveWorkerExecutionActor`，缺主体抛 `MissingHumanPrincipalError`。
5. **出站唯一出口**：所有 GitHub 网络调用只经 `GitHubConnector`，别处不许裸 `fetch` GitHub host。每次调用过 `validateOutboundUrl` + `hostAllowlist`。
6. **凭据只存密文**：GitHub App 私钥经 `FieldEncryption` 加密落库；installation token 是短时派生物，只在内存缓存，不落库。
7. **新表双登记**：任何新增租户级表（`github_learn_state`、若新增 GitHub 数据表）必须同时登记进 `src/multi-tenant/tenant-database.ts` 的 `TENANT_TABLES` **和** `src/privacy/privacy-service.ts` 的 `TENANT_TABLES`/`TENANT_TABLE_SET`（GDPR export/erase）。迁移须同步 schema-dsl 既有同步点（迁移文件/index/version-map/parity/legacy fixture 等，见既有节奏）。
8. **per-persona scope**：学习与游标按 `(tenant_id, persona_id)` 隔离（延续 ADR-0056）。
9. **前置人工步骤（非代码）**：GitHub App 的注册（拿 App ID / 私钥 PEM / webhook secret）是外部人工步骤，代码无法自动完成——作为配置输入，像 BYOK 一样。

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

**凭据存储（复用）**：
- 扩 `UserOauthTokenService`（`src/agent/user-oauth-token-service.ts`）与 `packages/kernel/src/domain/agent/user-oauth-types.ts` 的 `OauthProvider`，加 `'github'`。存 **App 私钥 PEM（加密）+ installation 映射（repo/org → installation_id）**。
- `user_oauth_tokens` 表已在两个 GDPR/隔离注册表内，复用即满足隔离与 GDPR export/erase。
- installation token 不落库（约束 6）。

**出站安全（复用）**：
- 每次调用先 `validateOutboundUrl(url, { hostAllowlist: ['api.github.com', <可配 GHE host>] })`（`src/security/ssrf-guard.ts`），scheme 强制 https。
- 复用 `url-content-fetcher.ts` 的 DNS-pin / 大小上限 / 超时 / `redirect:'manual'` 防重定向逃逸 allowlist。
- 速率限制：读响应 `X-RateLimit-Remaining`，近枯竭时退避，不硬打 429。

**分层**：
```
GitHubConnector          唯一网络出口
  ├─ GitHubAuthManager   App JWT + installation token 缓存/刷新
  ├─ GitHubApiClient     REST 端点（读/写）
  └─（复用）ssrf-guard + FieldEncryption + UserOauthTokenService
```

**可验证性**：真 public repo + 测试 App installation，`GitHubConnector.listIssues(repo)` 真拉到数据 = 接通证明。token 刷新用「强制缓存过期→下次调用应静默重签」测。

### 5.2 学习段：GitHubLearningMapper → perception 主干

**文件（新建）**：
- `src/integrations/github/github-learning-mapper.ts` — 四类内容 → representation 映射（本段唯一新领域逻辑）。
- `src/server/routes/companion/learn-github.ts` — 手动学习端点 `POST /api/v1/companion/me/learn-github`（body: repo + 要学哪几类）。与现有 `learn-topic`（`src/server/routes/companion/me.ts`）同层，复用 companion 路由骨架。

**端点前缀约定（有意区分）**：手动学习走 `companion/me/*`（数字人主人发起的学习动作，与 learn-topic 同层）；系统入站 webhook 走 `integrations/github/*`（5.3，非用户动作、无 companion 身份、走签名校验）。两者鉴权与身份模型不同，故前缀不同。

**「关键文件」启发式**：`code` 类型不逐文件全拉，只拉 README + 顶层目录结构 + 少量入口/清单文件（如 package.json/pyproject.toml 等）。具体选择启发式在 writing-plans 阶段定义并测（避免大 repo 全量拉爆配额，见 9 风险表）。

**四类内容 → representation 映射**（保留关键结构，不压成散文）：

| 内容类型 | 拉取 | representation 模板 |
|---|---|---|
| 代码 + README/文档 | repo tree + 关键文件 | `关于「<repo>」我学到：这是一个 <lang> 项目，做 <README 摘要>。核心模块：<顶层目录/关键 symbol 列表>` |
| Issues + 讨论 | issues + comments | `关于「<repo> issue #N」我学到：<标题>。问题是 <正文摘要>。讨论结论：<comment 要点>` |
| PR + code review | PRs + review comments | `关于「<repo> PR #N」我学到：<标题>。改了 <files-changed 列表>。review 意见：<要点>` |
| Commit 历史 | commits | `关于「<repo> 演进」我学到：近期提交 <commit message 聚合>，演进方向是 <推导>` |

**治理主干（全复用，零新治理逻辑）**：
```
GitHubLearningMapper.map(githubContent) → representation 文本
  → PerceptionDistiller.perceive({ representation, source:'perception' })
      ① PerceptionProvider.analyze()（可选 LLM 老师，BYOK，per-tenant）
      ② 硬校验 validFacts → 写 episodic/semantic 记忆（memoryGraph.addMemory）
      ③ 身份/价值提议 → 强制封顶（MAX_PERCEPTION_DELTA=0.05, patternAgrees=false）→ 永远 pending
      ④ distillation.ingest() → external 信任档；不确定性预算超 → 降级 manual pending
      ⑤ linkMemoryAssociatively() → co_occurrence 边 → 零-LLM 对话可检索
```

**决策：走 perception 而非 knowledge_sources**。`KnowledgeIngestionService` 直写记忆、绕过蒸馏门与信任层；走 perception 才让 GitHub 学习自动过 `external` 最严档。**不新建 `knowledge_sources` 的 `github` 类型**。

**增量与去重**：
- 新表 `github_learn_state`（见 6），记每个 `(tenant_id, persona_id, repo, resource_type)` 的同步游标：issue/PR 用 `updated_at`，commit 用 SHA，repo 用 tree SHA。
- 已学过且未变的跳过，只把新增/变更喂进 perception，避免同一 issue 反复灌记忆 + 重烧不确定性预算。

**触发**：手动（`learn-github` 端点）；自动（5.3 webhook 增量喂单条）。

**可验证性**：真拉一个 public repo → 学完 → 数字人零-LLM 对话能被问到「你从 X 学到什么」并 grounded 答出真实内容。信任层用「注入一条会诱导改价值观的 GitHub 内容 → 断言身份变更落 pending 不自动生效」测（变异测试证非空跑）。

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
    →【outboundCommitment → assessExecutionRisk 强制 requiresHuman=true，不可降级】
⑤【人工审批门】用户看到草稿 → 批准 / 驳回
    → 批准后 isExecutionApprovalCleared（绑定本次执行）
⑥ WorkerExecutionService.execute() → GitHubConnector 写（POST comment / review）
⑦ 审计留痕（谁批的、发了什么、到哪个 issue/PR）
```

**Webhook 接收器**：复用 Stripe 模式（`src/server/routes/billing.ts` + `src/billing/stripe-webhook-service.ts`）——raw body + 签名头校验 + 幂等表。GitHub 用 `X-Hub-Signature-256`（HMAC-SHA256，复用现有 `createHmac`+`timingSafeEqual` 助手，非 Stripe SDK）。签名校验失败直接拒，不进流程。

**两个 playbook**：注册进 `PlaybookRegistry`（`src/workforce/playbook-registry.ts`），产出 `TaskSpec`（`taskType`、`allowsToolExecution:true`、`riskLevel` 带 `outboundCommitment`、`acceptanceCriteria`、`requiredCapabilities`）。复用 `decomposition-playbook.ts` 现有机制。

**GitHubResponseComposer（零-LLM）**：基于数字人已学记忆（5.2）+ issue/PR 上下文，拼评论/review 草稿。参照 `OfflineConversationResponder`（persona narrative + 检索记忆 → 文本）的模式，但产出「评论/review」结构而非聊天散文。零-LLM，与内核铁律一致。

**治理红线（全部由现有机制强制）**：
- 写动作 `outboundCommitment` → `assessExecutionRisk` 强制 high + `requiresHuman:true` 不可降级（约束 3）。
- 执行时 `isExecutionApprovalCleared` 绑定本次执行（防「批 A 发 B」）。
- 人类法律主体永不为 null（约束 4）。
- 并发 CAS `delegated→in_progress`（防同一草稿双发）。
- 自主流永远只能起草：草稿停在 `delegated`，只有人工批准才 `→in_progress→执行`。

**可验证性**：
- webhook：正确签名 payload → 应创建任务起草；错误签名 → 应 401 拒绝。
- 审批门（最关键）：模拟「审批未清」→ 断言 `execute()` 拒绝发布；**变异测试**——把门拿掉后测试必须失败（证非空跑）。
- 绑定审批：批准任务 A 的执行 → 拿该批准去发任务 B → 应拒（`isExecutionApprovalCleared` 绑定校验）。

---

## 6. 数据模型

### 新表 `github_learn_state`（增量同步游标）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| tenant_id | TEXT | 隔离键 |
| persona_id | TEXT | per-persona（ADR-0056） |
| repo | TEXT | `owner/name` |
| resource_type | TEXT | `code` \| `issues` \| `pulls` \| `commits`（CHECK 约束） |
| cursor | TEXT | issue/PR: 最后 `updated_at`；commit: 最后 SHA；code: tree SHA |
| last_synced_at | INTEGER | 时间戳 |
| created_at / updated_at | INTEGER | |

**唯一约束**：`(tenant_id, persona_id, repo, resource_type)`。

**双登记（约束 7，强制）**：
- `src/multi-tenant/tenant-database.ts`：加入 `TENANT_TABLES`。
- `src/privacy/privacy-service.ts`：加入 `TENANT_TABLES`（有序数组）+ `TENANT_TABLE_SET`；完整性 ratchet 测试会强制覆盖。
- 迁移经 schema-dsl，同步其既有同步点。

### 复用表（不新建）
- `user_oauth_tokens`（扩 `github` provider，存 App 私钥密文 + installation 映射）。
- `webhook_events`（复用幂等）。
- 记忆表（`persona_memories` 等，经 perception 写入）。

---

## 7. 前置人工步骤（spec 明确，代码不做）

1. 在 GitHub 注册一个 GitHub App，配置：读权限（Contents/Issues/Pull requests/Metadata）、写权限（Issues/Pull requests，用于反馈）、webhook（订阅 Issues/Pull requests 事件）。
2. 拿到 `App ID`、私钥 PEM、webhook secret。
3. 把 App 安装到目标组织/仓库，拿 installation。
4. 将 App ID / 私钥 / webhook secret / installation 映射填入配置（私钥经加密凭据库）。

---

## 8. 分片与可验证性（供 writing-plans 拆计划）

按段拆，每片自含、可独立验证：

- **Plan 1（接）**：GitHubConnector + AuthManager + ApiClient（读端点）+ 凭据扩 github provider。验证：真拉 public repo。
- **Plan 2（学）**：GitHubLearningMapper + learn-github 端点 + github_learn_state 表 + 增量去重。验证：学完可零-LLM 问答 grounded；信任层封顶变异测试。
- **Plan 3（反馈）**：github-webhook 接收器（签名+幂等）+ 两 playbook + GitHubResponseComposer + 接 workforce 执行链。验证：签名正/误、审批门变异测试、绑定审批测试。
- **Plan 4（写端点接线）**：GitHubApiClient 写方法（comment/review）接入 GitHubConnector，经 workforce 执行落地。验证：批准后真发到测试 repo（隔离的测试环境）。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| GitHub 结构化数据压成 representation 损失结构 | 映射器针对性保留 symbol/files-changed/结论等关键结构（5.2 模板） |
| installation token 泄露面 | 只内存缓存不落库；私钥加密存储 |
| webhook 重投导致重复起草 | `webhook_events` 幂等表（复用 Stripe 模式） |
| 大 repo 全量拉爆配额/预算 | 增量游标 + 只喂变更 + X-RateLimit 退避 + 不确定性预算封顶 |
| 反馈误发（对外不可逆） | 不可降级人工审批门 + 绑定审批 + 并发 CAS（约束 3/4） |
| SSRF / 重定向逃逸 allowlist | ssrf-guard host allowlist + DNS-pin + redirect:manual |
| 新表漏登记 GDPR/隔离 | 约束 7 双登记 + ratchet 测试强制 |

## 10. 非目标（YAGNI）

- 不做通用「任意出站 HTTP 工具」（只做 GitHub 专用 Connector）。
- 不做 GitHub 之外的 SCM（GitLab/Bitbucket）——未来另立。
- 不做自动合并 PR / 自动关 issue 等高危写动作（首版只 comment/review）。
- 不做 GitHub App 的自动注册（前置人工步骤）。
