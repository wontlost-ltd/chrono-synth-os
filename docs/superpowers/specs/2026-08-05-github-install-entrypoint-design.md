# GitHub App 安装入口产品化设计

**日期**: 2026-08-05
**状态**: 设计定稿，待实施
**关联**: [讨论内容摄入](2026-08-02-github-discussion-ingestion-design.md)、[组织级驻留](2026-08-02-github-org-residency-design.md)、[webhook 接学习](2026-08-02-github-webhook-learning-design.md)、GitHub 集成 Plan 1（接入）

---

## 1. 问题陈述

数字人现在能学到 GitHub 真知识、能自动学完整个组织、新讨论能几秒进记忆。但**把 App 装进系统这一步仍是运维手工活**——这是 GitHub 集成最后一个缺口。

三个具体障碍：

**① 凭据只能靠一次性脚本。**`scripts/connect-github.ts` 的文件头自陈：「一次性脚本……验收用，Plan 1-2 尚无管理端点」。它要求 SSH 登服务器、设 5 个环境变量、跑 node。全仓无任何 GitHub 凭据管理端点。

**② 无安装回调。**GitHub App 装完会跳 `setup_url`，但系统没有这个端点。`installation_id → 租户` 的映射只能靠脚本手输。

**③ installation 类事件完全未处理。**`github-webhook.ts` 不认 `installation` 与 `installation_repositories` 事件。后果：App 被卸载、被暂停、授权仓库增删，系统一无所知——已卸载的租户，组织同步 worker 仍会持续对其发请求。

---

## 2. 设计目标

1. 管理员经 HTTP 端点完成凭据录入，不必登服务器
2. GitHub 装完 App 自动回记 `installation → 租户` 映射
3. 装/卸/暂停/改授权经 webhook 自动同步，表真实反映 GitHub 侧状态
4. 卸载后学习自动停止
5. 私钥绝不经 URL、绝不回显、加密落库

---

## 3. 架构

三层，各司其职。

### 3.1 管理端点：一次性录凭据

| 端点 | 作用 |
|---|---|
| `POST /api/v1/admin/github/app` | 录入 `{appId, privateKeyPem, webhookSecret, gheBaseUrl?}` |
| `GET /api/v1/admin/github/app` | 查连接状态（**不含私钥**） |
| `DELETE /api/v1/admin/github/app` | 断开连接 |

全部 `requireRole('admin')`（照 `admin-config.ts` 既有范式）。

**私钥安全三条**：只经 POST body 进入（绝不 GET/URL）；经 `GithubAppCredentialStore.storeApp` 由 `FieldEncryption` 加密落库（store 自身 fail-closed，加密未启用直接拒写）；响应体绝不回显私钥——`GET` 只返 `{configured, appId, gheBaseUrl, installations:[...]}`。

`DELETE` 复用既有 `GITHUB_APPCRED_CMD_DELETE`（kernel 已有该命令）。

### 3.2 setup_url 回调：只记映射

`GET /api/v1/integrations/github/setup?installation_id=<id>&setup_action=install`

只做一件事：把 `installation_id → 当前会话租户` 记进 `github_installations`。

**这是本设计最需要小心的一环。**它是 GitHub 发起的浏览器跳转，**没有 HMAC 签名可验**（不同于 webhook）。因此：

- **必须要求已登录**（走正常 JWT 鉴权，不加入 `isPublicPath` 豁免）
- **租户身份取自会话**（`request.tenantId`），**绝不从 URL 参数推断**

若不这样做，任何人构造 `?installation_id=<别人的>` 就能把他人的 installation 绑到自己租户下，进而用自己的会话读取他人组织的 GitHub 内容。这是本设计的**首要安全不变量**。

回调成功后返回一个极简 HTML 确认页（纯静态文本，无用户输入回显，无 XSS 面）。

### 3.3 installation 事件：自动同步

并入既有 webhook 路由，**天然享受现成的 HMAC 验签 + installation 反查 + delivery 幂等**。

| 事件 | action | 处理 |
|---|---|---|
| `installation` | `created` | upsert 映射（补回调遗漏） |
| `installation` | `deleted` | **删映射** → 学习自动停 |
| `installation` | `suspend` | 标 `suspended_at` |
| `installation` | `unsuspend` | 清 `suspended_at` |
| `installation_repositories` | `added` / `removed` | 同步 `repos` 列 |

**「卸载即停学」是免费的（已核实）**：`assembleGitHubReadPort`（`github-readport-factory.ts:48`）在无 installation 行时返回 `{failure: 'no-installation'}`；组织同步 worker 与 `github-learn` 队列 handler 都已对该失败静默跳过。删掉行即自动停止学习，无需额外逻辑。

**反查租户的特殊性**：`installation.created` 事件到达时，该 installation 可能尚未在库中（回调与 webhook 到达顺序不保证）。既有 webhook 链的第②步「反查租户 fail-closed」会因查不到而返 401。故 `created` 事件需在反查失败时**特殊放行**——但仅限于「已能验签」的前提下。而验签需要租户的 webhook secret……这形成循环依赖。

**解法**：`installation.created` 事件**不特殊处理**，仍走既有 fail-closed 拒绝路径。映射由 §3.2 的回调负责建立（回调有会话身份，是权威来源）。`created` 事件仅在映射已存在时作为幂等补记。这样既不破坏 fail-closed 安全性，也不引入循环依赖——**回调是建映射的唯一权威路径**。

---

## 4. 需要补的底座

### 4.1 installation 删除命令（kernel）

kernel 有 `githubAppCredDelete`（`github-app-types.ts:100`）但**没有** installation 的删除命令。`deleted` 事件要真删映射就必须新增 `githubInstallDelete`。

### 4.2 迁移 v127：`suspended_at` 列

`github_installations` 表当前无暂停状态列（`v119.ts:44-56`）。新增 `suspended_at BIGINT`（可空，NULL = 未暂停）。

**纯加列不重建表**——PG 用 `ADD COLUMN IF NOT EXISTS`，SQLite 直接 `ADD COLUMN`，规避 SQLite 重建表时「RENAME 占用索引名致 CREATE INDEX 静默 no-op」的已知坑。

**代价诚实说明**：这意味着又一轮 6 处迁移同步点（迁移文件 / index 三处 / version-map / parity 覆盖列表 / VERSION_MAP range）。不做 suspend 的代价是：App 被暂停后系统不知道，worker 持续对暂停的装机发请求拿 403。判断是值得做。

### 4.3 `repos` 列真正投入使用

该列现在**写了从不读**（Plan 1 写入，无任何生产消费者）。本设计让 `installation_repositories` 事件维护它，使其成为有效数据。

---

## 5. 关键取舍

**回调不做 CSRF `state` 校验。**标准 OAuth 用 `state` 防 CSRF，但本场景不同：回调不换取任何凭据，只在**已登录会话**下记一条映射。要求登录 + 用会话租户已堵住主要风险面（攻击者无法把他人 installation 绑到自己名下，因为绑定用的是他自己的会话租户；他能做的只是把**自己的** installation 绑到自己租户——无害）。加 `state` 需额外临时存储，收益不匹配。

**私钥仍需人工粘贴一次。**这是 GitHub 的设计（私钥只在创建 App 时下载一次），任何方案都绕不开。能做的是让它只发生一次、走 POST body、加密落库、绝不回显。

**`installation.created` 不建映射。**如 §3.3 所述，为避免破坏 fail-closed 反查而放弃——回调是唯一权威路径。若用户先装 App 再登录（回调时未登录），需重新走一次安装流程；GitHub 支持从 App 设置页重新触发 setup_url。

---

## 6. 测试策略

### 单元测试
- installation 事件 → 动作映射：created/deleted/suspend/unsuspend、`installation_repositories` added/removed、未知 action 忽略
- 畸形 payload（缺 installation.id / 缺 repositories 数组）不抛错

### 集成测试
- `POST /admin/github/app` 录凭据 → `GET` 返 `configured: true` 且**响应体不含私钥**（安全断言）
- 非 admin 角色 → 403
- **回调未登录 → 401**（首要安全不变量）
- 回调已登录 → 映射记到**会话租户**（而非 URL 参数推断的租户）
- `installation.deleted` webhook → 映射消失 → 后续 ReadPort 装配返 `no-installation`（端到端证「卸载即停学」）
- `installation.suspend` → `suspended_at` 被设置

### 迁移测试
- `suspended_at` 可写可读；既有行 NULL 兼容
- 唯一索引 `idx_github_installations_host_iid` 仍存在（`PRAGMA index_list` 内省）

### 回归测试
- 既有 webhook 5 个安全测试（验签/幂等/反查/起草/非 opened）全绿
- 既有 4 个学习入队测试全绿
- **内核封顶变异测试仍有效**

---

## 7. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 回调被用于劫持他人 installation | **高** | 必须已登录 + 租户取自会话，绝不从 URL 推断；专项测试锁死未登录 401 |
| 私钥泄露（回显/日志/URL） | **高** | 只走 POST body；响应绝不含私钥；加密落库（store fail-closed） |
| 迁移 6 处同步点漏一处致 CI 红 | 中 | 严格走 checklist；merge 前跑 `test:golden` 全门 |
| 卸载后残留映射致 worker 白发请求 | 中 | `deleted` 事件真删映射；「卸载即停学」经端到端测试证明 |
| `installation.created` 先于回调到达 | 低（已接受） | 回调为唯一权威路径；GitHub 支持重新触发 setup_url |

---

## 8. 验收标准

1. 管理员经 `POST /admin/github/app` 录入凭据，`GET` 可查状态且响应不含私钥
2. 非 admin 访问管理端点 → 403
3. setup 回调未登录 → 401；已登录 → 映射记到会话租户
4. `installation.deleted` → 映射删除 → 学习自动停（ReadPort 装配返 no-installation）
5. `installation.suspend/unsuspend` → `suspended_at` 正确置位/清除
6. `installation_repositories` 事件同步 `repos` 列
7. `npm run test:golden` 全门通过
8. 内核封顶变异测试仍然有效
