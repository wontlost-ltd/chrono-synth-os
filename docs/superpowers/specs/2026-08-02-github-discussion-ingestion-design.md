# GitHub 讨论内容摄入设计（listComments）

**日期**: 2026-08-02
**状态**: 设计定稿，待实施
**关联**: ADR-0047（LLM 当老师）、ADR-0051（感知即感官老师）、GitHub 集成 Plan 2（学习，已合入 564f31c）

---

## 1. 问题陈述

GitHub 学习管线（Plan 2）表面支持四类内容（code/issues/pulls/commits），但 **issue 与 PR 的讨论内容从未真正进入记忆**。

`src/integrations/github/github-learning-service.ts:165,171` 把 comments 硬编码为空数组：

```ts
const items = issues.map((issue) => mapIssue(repo, issue, []));
const items = pulls.map((pull) => mapPull(repo, pull, []));
```

其行内注释说明了原因：「讨论内容 ReadPort 不透传（只读精简 port），comments 传空，mapper 会填占位」。

后果：`GitHubReadPort` 接口（`github-read-port.ts:76-87`）没有任何 comments 方法，因此每条学到的 issue 记忆字面写着 `讨论结论：（暂无讨论）`（mapper:105），每条 PR 记忆写着 `review 意见：（暂无 review 意见）`（mapper:121）。

**组织中信息密度最高的知识——issue 讨论串与 PR review 意见——完全未被摄入。**数字人只学到了标题和正文，学不到「这个问题最后怎么定的」。

### 本设计不解决的问题（明确划界）

- 组织级仓库枚举（`/installation/repositories`）
- 定时同步 worker
- GitHub App 安装入口产品化
- Discussions / Wiki（需 GraphQL，另一条线）
- 桌面端知识同步

以上属于后续 plan。本设计**只补讨论内容摄入**这一个缺口。

---

## 2. 设计目标

1. issue 讨论与 PR review 意见真正沉淀为记忆
2. 讨论演进时记忆随之演进，**不重复堆积**
3. API 调用量可控，不触发 GitHub 二级速率限制
4. 零-LLM 铁律不破：LLM 仍只在 perceive 摄取阶段当感官老师
5. 内核封顶不破：GitHub 内容绝不能擅改人格价值观

---

## 3. 架构

四层改动，**不新增表**（仅加一列）。

### 3.1 ReadPort：两个只读方法

`src/integrations/github/github-read-port.ts` 的 `GitHubReadPort` 接口新增：

```ts
/** 列 issue 的讨论评论正文（按时间升序）。 */
listIssueComments(repo: string, issueNumber: number): Promise<string[]>;
/** 列 PR 的 review 评论正文（按时间升序）。 */
listPullReviewComments(repo: string, pullNumber: number): Promise<string[]>;
```

实现复用现成的 `fetchAllPages` 与 `buildListUrl`，走同一个 SSRF 网关（`githubFetch`）与同一套分页上限（`MAX_LIST_PAGES = 10`）。

端点：
- issue 评论：`GET /repos/{repo}/issues/{number}/comments`
- PR review 评论：`GET /repos/{repo}/pulls/{number}/comments`

返回值只取每条评论的 `body` 字符串数组，丢弃作者/时间等元数据——mapper 只消费正文。

**只读契约不破**：新增的都是 list 方法，`github-write-port-arch.test.ts` 锁死的「ReadPort 无写方法」反射断言依然成立。

### 3.2 Service：游标内增量抓取

`github-learning-service.ts` 的 `fetchAndMap` 中，issues/pulls 分支改为逐条抓取讨论。

**省配额的两道闸**：

1. **增量游标**（已有机制，零新增成本）：`listIssues(repo, since)` 本就只返回游标之后有更新的条目。稳态下每轮通常只有个位数条目需要抓评论，而非全量。
2. **评论数为零则跳过**：GitHub 的 issue 列表响应自带 `comments` 计数字段。计数为 0 时直接跳过，**不发出任何额外请求**。

单条评论抓取失败不中断整批：捕获异常后以空数组降级（该条记忆退回「（暂无讨论）」），保证一条坏数据不阻塞整个 repo 的学习。

### 3.3 演进式取代（核心设计）

#### 问题

`contentSha = sha256(representation)`（mapper:143-146），而去重账本 `github_ingest_digests` 以此 sha 为键。一旦表征包含评论，**每新增一条评论就产生新 sha**，去重账本失效——同一个 issue 会被反复当作「新内容」沉淀，记忆库里堆积大量近似重复的碎片。

#### 方案

`github_ingest_digests` 新增一列 `discussion_key`（可空，形如 `issues:owner/repo#42`），并记录该 key 当前对应的 memoryId。

摄入流程变为：

```
表征 sha 未见过（claimDigest 抢到）
  → perceive() 返回 memoryIds
  → 查同 discussion_key 的旧 memoryId
  → 存在则 memories.deleteMemory(旧 memoryId)
  → 记录 discussion_key → 新 memoryId
```

**结果：每个 issue/PR 在记忆库中恒为一条，内容始终是最新共识。**

#### 可行性验证（已核实）

- `PerceptionDistiller.perceive()` 返回 `{memoryIds, candidates, teacherFailed}`（`perception-distiller.ts:133`）——能拿到新记忆 ID
- `MemoryGraph.deleteMemory(id)` 存在（`src/core/memory-graph.ts:99-101`）——能删旧记忆

#### 已知取舍：取代是有损的

旧版记忆被物理删除，**历史讨论过程不可追溯**，记忆库只保留最新状态。

判断依据：组织知识的价值在于「当前共识」而非「考古」。若将来需要决策溯源（「这个决定当初为什么这么定」），可升级为软删除——`discussion_key` 设计为独立列正是为此留的口子，届时加 `superseded_at` 列即可，不必重构表结构。

本次不做（YAGNI）。

### 3.4 Mapper：零改动

`mapIssue` / `mapPull` 已经接受 comments 参数，已有 `summarizeComments`（单条 160 字符上限、最多纳入 5 条，mapper:41,43,169-175）。这一层是**纯接线**，不改任何代码。

---

## 4. 数据流

```
learn(repo, ['issues'])
  → listIssues(repo, since)            [仅游标后更新的条目]
  → 逐条：comments 计数 > 0 ?
      → listIssueComments(repo, num)   [有讨论才发请求]
      → mapIssue(repo, issue, comments) → {representation, contentSha}
      → claimDigest(contentSha)         [原子占位，已见过则跳过]
      → perceive({representation})      [LLM 老师抽事实 → 记忆]
      → 旧 memoryId 存在 ? deleteMemory(旧)
      → 记录 discussion_key → 新 memoryId
  → 全批成功 → advanceCursor
```

失败语义沿用现状：perceive 抛错 → 不推进游标，下次重拉，已摄入条目靠 digest 幂等跳过。

---

## 5. 迁移

`github_ingest_digests` 加一列 `discussion_key TEXT`（可空，兼容既有行）。

**迁移同步点共 6 处**（见项目既有约定），加列须逐一同步：迁移文件、index、version-map、parity 期望、legacy fixture 两数组、VERSION_MAP range。另需确认是否触及 SAFE-EXEMPT 表 SQL 的 ratchet 指纹。

合入前必须跑 `npm run test:golden` **全门**，而非 `test:packages` 子集——历史上正是子集漏检导致红测试进 main。

---

## 6. 测试策略

### 单元测试
- ReadPort 两个新方法：注入 `fetchImpl`，验证 URL 构造、分页跟随、空评论返回空数组
- ReadPort 只读契约反射断言（回归）
- mapper 接线：有评论时表征包含讨论要点

### 集成测试
- **取代语义**（核心）：学两次同一 issue，第二次带新评论 → 断言旧记忆已消失、新记忆存在、记忆总数不增
- **零评论跳过**：fetch-spy 计数断言无评论的 issue 不触发额外请求
- **降级容错**：评论抓取失败时该条退回「（暂无讨论）」，整批不中断

### 回归测试
- `github-learn-e2e.test.ts` 的**内核封顶变异测试必须仍然有效**：翻转 perceive 的 `patternAgrees` false→true 则测试转红，证明 GitHub 内容绝不能擅改人格价值观

---

## 7. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 首次全量学习 API 调用重（500 issue 仓库 = 500+ 次评论请求） | 中 | 单 repo 手动触发下可接受；组织级 worker 必须配限流——**留给下一个 plan** |
| 迁移加列漏同步点致 CI 红 | 中 | 严格走 6 处 checklist；merge 前跑 test:golden 全门 |
| 取代式删除丢历史 | 低（已接受） | 设计上留 `discussion_key` 独立列，将来可升级软删除 |
| 评论中的敏感信息进记忆 | 低 | 沿用既有 perceive 蒸馏门与内核封顶，与现有 issue 正文同等级 |

---

## 8. 验收标准

1. 对一个真实（或 fixture）repo 学习后，issue 记忆内容包含真实讨论要点，不再是「（暂无讨论）」
2. 同一 issue 新增评论后再学一次：记忆内容更新，记忆总数不增
3. 无评论的 issue 不产生额外 API 请求
4. `npm run test:golden` 全门通过
5. 内核封顶变异测试仍然有效
