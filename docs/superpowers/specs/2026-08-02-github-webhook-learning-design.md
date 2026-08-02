# GitHub webhook 接学习管线设计（事件驱动低延迟摄入）

**日期**: 2026-08-02
**状态**: 设计定稿，待实施
**关联**: [讨论内容摄入](2026-08-02-github-discussion-ingestion-design.md)、[组织级驻留](2026-08-02-github-org-residency-design.md)、GitHub 集成 Plan 3（起草）

---

## 1. 问题陈述

数字人现在能学到 GitHub 真知识（讨论摄入已补），也能自动学完整个组织（轮转 worker 已建），但**新知识进记忆有显著延迟**。

轮转是有意的限速设计：每轮 5 个仓库、30 分钟一轮，一个 50 仓库的组织约 5 小时轮完一周。组织里刚定下的结论，最坏要等 5 小时才进记忆。

而**事件通道其实早就存在但没接上**：`src/server/routes/github-webhook.ts` 已有完整的安全链（HMAC 验签 → installation 反查租户 → `X-GitHub-Delivery` 幂等），但它收到事件后做的是**起草回复**——全程不 import `GitHubLearningService`，且只认 `action === 'opened'`。也就是说 GitHub 已经在实时推事件过来，系统却只用它起草、不用它学习。

### 本设计不解决的问题（明确划界）

- **安装入口产品化**——仍靠一次性脚本 `scripts/connect-github.ts`，无 App 安装回调、无管理端点、无 `installation` 类事件处理。这是 GitHub 集成最后一个缺口。
- **既有起草路径**——零变更，本设计只在末端并联学习分支。

---

## 2. 设计目标

1. 组织里新发生的讨论**几秒内**进记忆，而非等轮转
2. webhook **绝不超时**（GitHub 约 10 秒预算，而 perceive 要调 LLM 老师）
3. 高频事件不烧 LLM 老师额度
4. 既有 webhook 安全链与起草行为零变更
5. 零-LLM 铁律与内核封顶不破

---

## 3. 架构

**零新表、零新 worker 骨架**——复用既有 `TaskQueue` + `TaskWorker`。

### 3.1 webhook 侧：验签后入队，立即返回

既有安全链（`github-webhook.ts:112-185`）**完全不动**：rawBody 捕获 → 加密可用性 fail-closed → installation 反查租户 fail-closed → HMAC 验签 fail-closed → delivery 幂等 claim。

在幂等 claim **之后**、起草分支**之外**并联一条学习分支：把「该学什么」入队，立刻返回。

**为什么异步**：perceive 要调 LLM 老师抽事实，单条 1-3 秒，遇上老师慢或重试会逼近 GitHub 的 ~10 秒超时。异步入队后 50ms 内返回 200，绝不超时。

**为什么复用 `TaskQueue`（`src/queue/task-queue.ts`）**：它已具备租户隔离（`tenantId` 入参）、重试（`maxRetries`）、优先级、状态机（pending/running/completed/failed）与保留期清理；`TaskWorker`（`src/queue/task-worker.ts`）已具备 handler 注册、超时、reaper、并发控制。新建队列表与消费者骨架属重复造轮子。OS 已在构造函数装配 `this.queue = new TaskQueue(this.db)`，接线点现成。

入队 payload 极小：`{ repo, resourceType, targetNumber }`。

### 3.2 事件覆盖：全事件，push 降频聚合

| 事件 | action | 处理 |
|---|---|---|
| `issues` | opened / edited / closed | 即时入队学（resourceType=`issues`） |
| `pull_request` | opened / edited / closed | 即时入队学（resourceType=`pulls`） |
| `issue_comment` | created / edited | 即时入队学（resourceType=`issues`） |
| `pull_request_review_comment` | created / edited | 即时入队学（resourceType=`pulls`） |
| `release` | published | 即时入队学（resourceType=`code`） |
| `discussion` | created / edited | **忽略**——ReadPort 无 Discussions 支持（需 GraphQL），入队会导致 handler 必然失败 |
| **`push`** | — | **不入队**，只标记该 repo 的 commits 待扫 |
| 其余 | — | 200 忽略（沿用现有语义） |

**push 为何降频**：活跃组织每天几百次 push，逐次调 LLM 老师会显著烧额度；而 `fix typo` / `wip` 这类 commit 信息密度低，逐条摄入还会稀释记忆信号。`commits` 资源类型在 mapper 里**本就聚合成一条表征**（`mapCommits`），天然适合批量而非逐次。

**标记怎么存（零新结构）**：把该 repo 的 `commits` 游标行 `last_synced_at` 归零，交给轮转 worker 下次扫到时用既有增量游标批量学。

**discussion 为何忽略**：`GitHubReadPort` 无 Discussions 方法（GitHub Discussions 只有 GraphQL API），入队后 handler 无从取内容、必然失败并耗尽重试。诚实忽略优于制造必败任务。

### 3.3 handler 侧：复用 learn() 全部逻辑

注册一个 `github-learn` 类型的 handler：取 payload → 用共享工厂 `assembleGitHubReadPort` 装配 ReadPort → 调 `GitHubLearningService.learn(repo, [resourceType])`。

**关键收益**：因为复用既有 `learn()`，上一轮建的两项能力自动生效——
- **讨论内容摄入**：抓到的评论真进表征；
- **演进式取代**：同一 issue 被反复评论时，每次 webhook 都把记忆刷新为最新共识，而不是堆积近似重复。

这正是「事件驱动」与「演进式取代」的天然契合点：讨论每变一次，记忆跟着演进一次。

**装配失败**（无凭据/无 installation）：handler 记日志并把任务标记完成（非失败）——租户已断开 GitHub 时不该无限重试。

---

## 4. 数据流

```
GitHub 事件到达
  → 验签 / 反查租户 / delivery 幂等         [既有链，不动]
  → 起草分支（opened 事件）                  [既有行为，不动]
  → 学习分支（本设计新增）：
      · push       → 归零 commits 游标 last_synced_at（交轮转批量学）
      · discussion → 忽略（ReadPort 无 GraphQL 支持）
      · 其余映射事件 → queue.enqueue('github-learn', {repo, resourceType, targetNumber})
  → 200（50ms 内）

TaskWorker 稍后消费
  → assembleGitHubReadPort（共享工厂）
  → learn(repo, [resourceType])
      · 增量游标只覆盖有更新条目
      · 评论数为 0 跳过不发请求
      · digest 账本防重复摄入
      · 演进式取代：刷新为最新共识
```

---

## 5. 关键取舍

**失去 GitHub 重投兜底。**同步方案里 perceive 失败可返 5xx 让 GitHub 重投；异步已返 200，GitHub 不会再投。缓解靠 `TaskQueue` 自带重试（`maxRetries`），失败任务留在队列可查。这是异步换来的确定代价。

**LLM 老师额度随事件量增长。**即时学意味着讨论越活跃消耗越多。push 已降频，但 issue/comment 类仍即时——这是「低延迟」的固有成本。

**入队与消费的租户上下文必须一致。**入队时用 webhook 反查出的 `tenantId`；handler 消费时必须用任务自带的 `tenantId` 装配 ReadPort，绝不可用默认租户——否则跨租户读取他人 GitHub 内容。这是本设计的**首要安全不变量**。

---

## 6. 测试策略

### 单元测试
- 事件 → 资源类型映射：六类事件各自映射正确
- push 事件 → 返回特殊标记（不映射为入队）
- discussion / 未知事件 → 不映射（忽略）
- payload 提取 repo/编号；缺 `repository.full_name` 等畸形 payload 容错不抛

### 集成测试
- webhook 收到 `issue_comment` → 队列多一条 `github-learn` 任务，**响应 200**
- webhook 收到 `push` → **不入队**，该 repo commits 游标 `last_synced_at` 归零
- handler 消费任务 → 讨论内容真进记忆（端到端）
- **跨租户隔离**：任务携带的 tenantId 被 handler 使用（安全不变量）

### 回归测试
- 既有 webhook 测试（验签失败 401 / 重投幂等 / 反查失败 401 / opened 起草 / 非 opened 忽略）全绿
- **内核封顶变异测试仍有效**：翻转 `patternAgrees` false→true 则测试转红

---

## 7. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 跨租户串扰（handler 用错租户装配 ReadPort） | **高** | 任务 payload 携带 tenantId，handler 必须使用；专项集成测试锁死 |
| 失去 GitHub 重投兜底 | 中（已接受） | TaskQueue 重试 + 失败任务可查 |
| 活跃组织烧 LLM 额度 | 中 | push 已降频聚合；issue/comment 即时是低延迟的固有成本 |
| discussion 入队必败耗尽重试 | 低 | 明确忽略该事件（ReadPort 无 GraphQL） |
| 入队失败影响 webhook 响应 | 低 | 入队异常捕获后仍返 200（起草已成功，学习可等轮转补） |

---

## 8. 验收标准

1. webhook 收到讨论类事件后入队并**快速返回 200**
2. handler 消费后讨论内容真进记忆
3. push 事件不入队，只标记游标
4. 任务携带的租户上下文被 handler 使用（无跨租户串扰）
5. 既有 webhook 安全链与起草行为零变更（既有测试全绿）
6. `npm run test:golden` 全门通过
7. 内核封顶变异测试仍然有效
