# Chrono-Synth 内测清单（Pre-GA Dogfooding）

**版本**：v1.0-beta
**生成日期**：2026-05-24
**适用范围**：四仓系统（chrono-synth-os / -web / -desktop / -deploy）
**前置门禁**：§8 跨模型双审 89/100 PASS

---

## 内测目标

把刚落地的三个 GA 关键修复（JWT 热轮换 / 边界 Zod 解析 / KMS 锚定失败 evidence）放到真实设备上跑过，覆盖单元/集成测试无法覆盖的盲区：

- 真实浏览器 EventSource 行为（特别是 iOS Safari）
- 触控目标在真机的可达性
- 长跑稳定性（24h SQLCipher / KMS 锚定漂移）
- 多 Pod / 多实例下 JWT 跨节点同步
- auto-updater 在 macOS 上的签名验证

**通过标准**：所有"必须"用例零 Critical/Major 失败；Minor 失败 ≤3 项且有缓解措施。

---

## 设备分工

| # | 设备 | 角色 | 重点用例数 | 优先级 |
|---|------|------|-----------|--------|
| 1 | Synology NAS | 主后端宿主 | 18 | P0 |
| 2 | Oracle Cloud | 多实例 / 备线 | 12 | P0 |
| 3 | MacOS | 桌面客户端 | 15 | P0 |
| 4 | iPhone 12 | iOS Safari + PWA | 10 | P0 |
| 5 | iPad mini 5 | iPad Safari + 分屏 | 8 | P1 |
| 6 | 浏览器矩阵 | Chrome / Safari / Firefox / Edge | 12 | P0 |

---

## 1. Synology NAS（主后端宿主）

**部署形态**：Docker compose，chrono-synth-os + chrono-synth-web 反代到 443。

### 必须用例（P0）

#### NAS-01 启动健康检查
- [ ] `docker compose up -d` 全部容器 healthy
- [ ] `curl -k https://<nas>/healthz` 返回 200
- [ ] `curl -k https://<nas>/readyz` 返回 200，body 包含 `database: ok`
- [ ] SQLCipher 启动密钥从 env 读取成功（日志无 `SQLCipher boot key missing`）

#### NAS-02 SSO 登录端到端
- [ ] 浏览器打开 `https://<nas>/auth/login`
- [ ] 用 admin 账号登录，access token 返回
- [ ] 解码 token header.kid 应等于 jwt.keys 中的 active kid
- [ ] `/.well-known/jwks.json` 返回 active + grace keys

#### NAS-03 JWT 热轮换（Critical 修复验证）
- [ ] 当前 active kid 记为 `KID_OLD`
- [ ] 用 admin token POST `/api/v1/auth/keys/rotate` `{newActiveKid: "kid-beta-1", addNew: [...]}`，预期 200（**不是** 409 RESTART_REQUIRED）
- [ ] 重新登录，新 token 的 header.kid 应是 `kid-beta-1`
- [ ] 用新 token 访问 `/api/v1/users/me`，预期 200
- [ ] 用旧 token（kid-OLD）继续访问，应仍能通过（grace 状态）
- [ ] 把 KID_OLD 标 retired，旧 token 应被拒绝 401

#### NAS-04 KMS 锚定失败 evidence（Major 修复验证）— **deferred**

**状态**：deferred 到接入真实 KMS 的 staging 环境

**为什么 NAS 内测不验**：
- `audit-chain-anchor-service` 只在 `main.ts` 收到 `auditChainAnchors.kmsProvider`
  时启动。默认部署不带 KMS provider → anchor service 完全不运行 → 无失败行可写
- NAS 单 NAS beta 部署没接真 KMS（AWS KMS / GCP KMS / 自建 vault），加这一条
  会让 NAS 部署链路明显偏离 GA 生产形态
- §8 #1 Major 修复（commit `f799ac1`）已在单元 + 集成测试中验证：
  - `audit-chain-anchor-service.test.ts` 12/12 pass
  - 含 "persists evidence row when KMS sign throws" + "marks recovered once
    later anchor succeeds" 两条核心路径
- 真实生产触发场景是 production KMS 间歇故障，不是 day-1 部署能复现

**真要验时怎么做**（OCI 多 pod / 后续 staging）：
1. 部署一个真实 KMS（推荐 OCI Vault / AWS KMS / HashiCorp Vault dev mode）
2. 在 `main.ts` 启动时把 `kmsProvider` 注入 `ChronoSynthOS` config
3. 开启 feature flag：`audit.kms-sign-chain-tail` = true
4. 触发一些 audit 写入（任何 API 请求都会写）
5. 模拟 KMS 不可达（防火墙规则 / 服务停掉）→ 等 anchor interval 过完
6. 查 `audit_chain_anchor_failures` 表
7. 恢复 KMS → 再等 → 查 `recovered_at`

**回归保护**：见 src/test/integration/audit-kms-anchor.test.ts 第 12 个 case。
任何 anchor service 改动如果破坏 evidence 路径都会被 CI test 拦截。

#### NAS-05 长跑稳定性（24h）
- [ ] 启动后 24 小时观察：
  - [ ] 容器无 OOM / 重启
  - [ ] `audit_chain_anchors` 表行数稳定增长（每 60s + 1）
  - [ ] `audit_chain_anchor_failures WHERE recovered_at IS NULL` 长期为 0
  - [ ] JWT keyRing 的 grace key 状态正确（未自动 retire）
  - [ ] 内存占用稳定（< 500MB）

#### NAS-06 备份 + 还原
- [ ] 备份 SQLCipher DB 到 NAS 共享文件夹
- [ ] 启动恢复检查脚本 `npm run audit:restore-check`
- [ ] 报告应：`ok: true, issues: []`

### 推荐用例（P1）

- [ ] Feature flag SSE 长连接 24h 不断
- [ ] Webhook 重试逻辑（人为下线消费方 5 分钟）
- [ ] 大数据量分页（10k personas）

### 故障上报模板

每条失败用例填写：
```
[NAS-XX] <用例标题>
观察行为: ...
期望行为: ...
重现步骤: ...
日志摘录: <docker logs --tail 100>
严重度: Critical / Major / Minor
```

---

## 2. Oracle Cloud（多实例 / 备线）

**部署形态**：2 个 OCI Compute 实例 + 共享 PostgreSQL（同一 DB，两个 Pod 同时跑 chrono-synth-os）。

### 必须用例（P0）

#### OCI-01 双实例启动
- [ ] 两个 Pod 都 healthy
- [ ] 两个 Pod 的 `/jwks.json` 返回相同的 keys（按 kid 比对）
- [ ] DB 中 `jwt_signing_keys` 表两行写一致

#### OCI-02 JWT 跨实例同步
- [ ] 在 Pod-A 上 rotate 到新 kid
- [ ] 等 60s（默认 reload interval）
- [ ] 在 Pod-B 上签 token，header.kid 应等于新 kid
- [ ] 互发 token 应都能验证（双向）

#### OCI-03 KMS 锚定不分裂
- [ ] 两个 Pod 同时跑 anchor service
- [ ] 同一 (tenant, to_seq) 锚定行应只有一份（UNIQUE 索引保护）
- [ ] 失败行（如有）也按 (tenant, attempted_at) 分别记录

#### OCI-04 SSE feature-flag 一致性
- [ ] 浏览器同时连两个 Pod 的 `/api/v1/feature-flags/stream`
- [ ] 在管理端切换某个 flag
- [ ] 两个浏览器在 5s 内都收到 change 事件
- [ ] kill-switch 立即生效（命令面板 Cmd-K 立刻禁用）

#### OCI-05 Pod 重启不丢密钥
- [ ] `kubectl rollout restart` Pod-A
- [ ] Pod-A 重启后从 DB load keyRing
- [ ] active kid 应等于重启前的 active kid
- [ ] 历史 token（grace）仍可验证

### 推荐用例（P1）

- [ ] 网络分区：临时 block Pod-A → DB 连接，应进入降级模式而不是 panic
- [ ] 滚动升级：先升 Pod-A 再升 Pod-B，全程 zero downtime
- [ ] CPU/内存压测：每秒 100 req，观察 P99 延迟

---

## 3. MacOS（桌面客户端）

**测试目标**：chrono-synth-desktop Electron 应用 + auto-updater + SQLCipher 本地 + 5 种冲突 UI。

### 必须用例（P0）

#### MAC-01 首次安装 + 启动
- [ ] 从 release tag 下载 .dmg（或本地 build）
- [ ] 安装到 /Applications
- [ ] 首次启动通过 macOS Gatekeeper（已签名）
- [ ] 登录 NAS staging 后端，sync 引擎启动成功

#### MAC-02 auto-updater 签名验证
- [ ] 升级到 vN+1 版本（手动推送一个 +1 的 release）
- [ ] 应用应自动检测 + 下载
- [ ] 验证签名通过（公钥 pinning 不漂移）
- [ ] 用户确认后重启，新版本运行

#### MAC-03 SQLCipher 启动 quiz
- [ ] 首次启动应弹出 SQLCipher 密钥 quiz
- [ ] 通过 quiz 后本地 DB 可读写
- [ ] 关闭应用再开，应再次要求 quiz（不持久化解锁状态）

#### MAC-04 冲突 UI 五种 entity
- [ ] 在 NAS 端 + 桌面端同时改同一 persona（unique name）
- [ ] sync 后桌面应弹出冲突
- [ ] ConflictList 显示 1 条 persona 冲突
- [ ] 打开 ConflictDetail，预览 local / server diff
- [ ] 点 "keep local" → 冲突消失
- [ ] 重复测试 memory / task / device / policy 五种 entity 类型

#### MAC-05 ManualMergeEditor footgun 保护
- [ ] 在 ConflictDetail 选 "manual merge"
- [ ] 编辑器初始模板包含 `_localValues` / `_serverValues` 占位
- [ ] **不修改任何字段**直接提交 → 应拒绝（footgun 保护）
- [ ] 修改一个字段后提交 → 应接受

#### MAC-06 键盘可达性
- [ ] 用 Tab / Shift+Tab 走完 ConflictDetail 所有按钮
- [ ] 焦点环可见
- [ ] Enter 触发 "keep local"，Escape 关闭对话框

### 推荐用例（P1）

- [ ] 离线模式：拔网线 5 分钟，本地操作排队，连网后 sync
- [ ] 多窗口：同时开 2 个窗口，状态隔离
- [ ] 深色模式 + 中英切换

---

## 4. iPhone 12（iOS Safari + PWA）

**测试目标**：chrono-synth-web 在 iOS Safari 的兼容性 + EventSource + 触控目标。

### 必须用例（P0）

#### IOS-01 PWA 安装
- [ ] 打开 `https://<nas>/`
- [ ] Safari 分享 → "添加到主屏幕"
- [ ] 主屏图标正常，全屏启动无 Safari 工具栏

#### IOS-02 EventSource 稳定性（关键风险）
- [ ] 登录后打开仪表盘，feature-flag SSE 应自动连接
- [ ] 锁屏 5 分钟再解锁，EventSource 应自动重连
- [ ] 切换 WiFi → 4G，EventSource 在 30s 内重连
- [ ] 在控制台触发 kill-switch，应 5s 内生效

#### IOS-03 触控目标（WCAG 2.5.5）
- [ ] 用尺子量主要按钮：≥ 44pt × 44pt
- [ ] 重点测试：登录页 / 命令面板 / 冲突列表项
- [ ] 误触率：连续 5 次点击同一个按钮 0 误触

#### IOS-04 中英 i18n 切换
- [ ] 切换到中文，所有 UI 文本中文化
- [ ] 切换回英文，无遗漏键（无显示 `i18n.key.foo`）

#### IOS-05 SSO 登录回跳
- [ ] 点登录跳转到 IdP
- [ ] 完成认证后回跳到应用，token 写入 storage
- [ ] 关闭再开应用，仍处于登录态（refresh token 工作）

### 推荐用例（P1）

- [ ] VoiceOver 朗读关键页面
- [ ] 横屏 / 竖屏切换
- [ ] 与桌面端冲突解决联动

---

## 5. iPad mini 5（iPad Safari + 分屏）

**测试目标**：响应式断点 + 分屏多任务。

### 必须用例（P0）

#### IPAD-01 响应式断点
- [ ] 全屏模式：UI 走 desktop 布局（侧栏可见）
- [ ] 半屏（split view）：UI 走 tablet 布局（侧栏折叠）
- [ ] 三分之一屏：UI 走 mobile 布局（汉堡菜单）

#### IPAD-02 冲突解决触控
- [ ] 在 iPad 上打开冲突列表
- [ ] 触控选择，触控滑动差异列表
- [ ] 与 MAC-04 / MAC-05 等价覆盖

#### IPAD-03 VoiceOver
- [ ] 打开 VoiceOver
- [ ] 朗读冲突列表项（应包含 entity 类型 + 严重度）
- [ ] 朗读差异面板（应分别朗读 local / server）

### 推荐用例（P1）

- [ ] Apple Pencil 触控（无特殊集成，但不应误判）
- [ ] 外接键盘 Tab 走查

---

## 6. 浏览器矩阵（4 种）

**测试目标**：跨浏览器兼容性。每个浏览器跑同一组核心用例。

| 浏览器 | 版本要求 | 必跑用例 |
|--------|---------|---------|
| Chrome | 最新 stable | BR-01 ~ BR-12 |
| Safari | 最新 stable | BR-01 ~ BR-12 |
| Firefox | 最新 ESR | BR-01 ~ BR-12 |
| Edge | 最新 stable | BR-01 ~ BR-12 |

### 必跑用例（每个浏览器）

- [ ] **BR-01** 登录页正常渲染
- [ ] **BR-02** 登录成功后跳转
- [ ] **BR-03** 仪表盘加载（无 JS 错误）
- [ ] **BR-04** Feature flag SSE 连接成功
- [ ] **BR-05** Kill-switch 触发后 Cmd-K / Ctrl-K 失效
- [ ] **BR-06** 冲突列表加载（含 5 种 entity 测试数据）
- [ ] **BR-07** Zod schema 解析：人为返回坏 payload，应进入 load error 兜底
- [ ] **BR-08** 中英 i18n 切换
- [ ] **BR-09** axe-core 0 violations（在 DevTools 跑 axe 插件）
- [ ] **BR-10** Performance：LCP < 2.5s（在快网络）
- [ ] **BR-11** Console 无 error（除已知第三方 warning）
- [ ] **BR-12** 登出后 storage 清空

---

## 内测时间线

| 阶段 | 内容 | 预计时长 |
|------|------|----------|
| 准备 | 部署 NAS + OCI staging，准备测试账号 | 0.5 天 |
| 执行 | 5 台设备并行铺开 | 1 天 |
| 故障复测 | 修复 + 回归 | 0.5 天 |
| 报告 | 出 `internal-beta-report.md` 决定 GA | 0.5 天 |

**总计**：2-3 天

---

## GA 判定规则

| 失败级别 | 数量阈值 | 决策 |
|---------|---------|------|
| Critical | ≥ 1 | 阻塞 GA，必须修复 + 完整回归 |
| Major | ≥ 3 | 阻塞 GA，必须修复 + 小范围回归 |
| Major | 1-2 | 评估是否可缓解，决定推迟还是 GA |
| Minor | ≥ 10 | 推迟 1 个迭代 |
| Minor | < 10 | 可 GA，记录到下一迭代 backlog |

---

## 故障上报渠道

- **现场**：本 checklist 表格直接打勾 + 评注
- **集中**：每天 18:00 出当日 `daily-beta-log.md`
- **紧急 Critical**：立即停测，回到主 AI 协调修复

---

## 附录：测试账号 / 工具

- NAS staging URL：`https://<填入>`
- OCI staging URL：`https://<填入>`
- 测试 admin：`beta-admin@example.test` / `<填入密码>`
- 测试 member：`beta-member@example.test` / `<填入密码>`
- KMS 测试 endpoint：`<填入>`
- 锚定 quizz interval（调短便于内测）：`60s`
