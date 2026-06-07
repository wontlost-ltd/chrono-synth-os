# Phase 1 Release Notes — 企业岗位人格 SaaS

> **GA 版本**：基于 commit `c8a6ae9` 及之后。
> **目标客户**：希望快速部署 AI 客服、技术支持、销售、法务、HR、财务等岗位人格的企业团队。
>
> 配套文档：[Stripe 配置](../operations/stripe-setup.md) · [部署清单](../operations/p1-deployment-checklist.md)

---

## 概览

ChronoSynth Phase 1 把"数字人格内核"封装成可销售的企业 SaaS：客户在 30 秒内通过预设模板创建岗位人格，5 分钟内灌入领域知识，立即接入对话 API 服务终端用户。整套产品在多租户、PII 合规、Stripe 计费、订阅闸门等生产维度全部就位。

**Phase 1 解决的核心问题**：从"只是技术 demo"过渡到"可计费的企业 SaaS 单元"。

---

## 主要功能

### 1. 6 类预设岗位人格模板

无需训练即可使用：客服 / 技术工程师 / 法务 / 销售 / HR / 财务。每个模板包含：

- **核心价值锚点**（如客服：同理心 0.9、耐心 0.85、准确性 0.8）
- **角色叙事**（system prompt 基线）
- **行为约束**（never_discuss / always_escalate / require_confirmation）
- **可参考的知识类别**

模板支持 `{{占位符}}`，企业实例化时填入自己的金额阈值、升级角色名等：

```bash
POST /api/v1/admin/persona-templates/tpl_builtin_customer_service/instantiate
{
  "displayName": "Acme 客服-001",
  "templateVariables": {
    "refund_threshold": "¥5000",
    "escalation_role": "客服主管"
  }
}
```

也支持创建自定义模板（自定义 category、values、boundaries）；自定义与内置可在租户内并存。

### 2. 知识库批量导入

一次提交最多 500 条来源；支持 text / url / file 三类。

- ≤20 条同步处理，HTTP 请求内完成
- \>20 条入异步队列，返回 jobId 供轮询
- **去重**：基于 fingerprint，重复条目不浪费 LLM 资源
- **SSRF 防护**：URL 拒绝 RFC1918 / 169.254 / 回环 / IPv6 link-local；对 5MB / 10s 设上限
- **模板联动**：`expectedTemplateId` 时自动校验来源 `category` 是否在模板的 `requiredKnowledgeCategories` 列表内，统计匹配率

```bash
POST /api/v1/persona-core/<personaId>/bulk-knowledge-imports
{
  "expectedTemplateId": "tpl_builtin_customer_service",
  "sources": [
    { "kind": "text", "content": "退货政策...", "category": "refund_policy" },
    { "kind": "url",  "content": "https://faq.example.com/shipping" }
  ],
  "deduplicateStrategy": "skip"
}
```

### 3. 生产级对话接入

POST 同步与 SSE 流式两种端点；按 `(personaId, externalUserId)` 速率隔离；端到端 P95 < 2s。

**多层安全防御**：
- **ValueGuard**：字面匹配 + 高显著度模式 + embedding 相似度 + 可选 LLM 分类器，命中 `never_discuss` 主题则不发往 LLM 直接降级响应
- **require_confirmation**：服务端拦截，签发一次性 confirmationToken，客户端携带 token 重发后才放行；token 与输入哈希绑定防篡改
- **PII 脱敏**：手机号 / 邮箱 / 身份证 / 银行卡 / IPv4 / JWT / API key 共 7 类，覆盖 user input、history、LLM output、audit log
- **字段加密**：`conversation_messages.user_input/assistant_output` 列接入 FieldEncryption；密钥引用持久化便于轮换

**可用性保障**：
- **Circuit breaker**：5 次失败开断；30s 执行超时；指数退避重试（默认 2 次）
- **降级路径**：LLM 不可达时绝不返回 5xx。
  - P1 行为：返回静态 `FALLBACK_RESPONSE` + `guardAction='llm_fallback'`。
  - **ADR-0047 起（自主模式）**：改为由确定性离线回应器据 persona 叙事 + 已检索知识生成人格落地回应，`guardAction='autonomous_response'`（非故障，区别于 `llm_fallback`）；仍无 5xx。详见 [ADR-0047](../adr/0047-llm-as-distillable-teacher.md)。
- **Quota 闸门**：Token Budget + QuotaManager 双重检查；耗尽时 `guardAction='quota_exceeded'`

**置信度可解释**：每条响应附带 `confidence: { score, level, interval, factors[] }`，前端可视化"为什么是这个分数"。

**GDPR / 合规**：
- `retention_class: standard | extended | litigation_hold`
- `DELETE /persona-core/<id>/conversations` 删除全部对话（litigation_hold 受保护）
- `ConversationRetentionWorker` 每小时清理过期消息

### 4. Stripe 真实订阅 + 用量计费

四档计划 + 一档 legacy：

| 计划 | 价格 | maxPersonas | 月对话 | 知识 GB | 月批量导入 |
|------|------|-------------|--------|---------|-----------|
| free | $0 | 1 | 100 | 0.1 | 50 |
| **starter** | $99/mo | 5 | 5,000 | 5 | 1,000 |
| **growth** | $499/mo | 25 | 50,000 | 50 | 10,000 |
| enterprise | custom | – | – | – | – |
| pro (legacy) | $49/mo | 5 | 5,000 | 5 | 1,000 |

**Webhook 完整覆盖**：
- `customer.subscription.created/updated/deleted` → status / plan_id / trial_end / cancel_at_period_end 同步
- `customer.subscription.trial_will_end` → 业务侧通知触发器
- `invoice.paid` / `invoice.payment_succeeded` → past_due 恢复 + 配额恢复
- `invoice.payment_failed` → past_due + 3 天 grace period

**用量计量**：每条已交付的对话消息上报 `chrono_conversation_message`（按消息计费，非按 LLM token；ADR-0047 起 `autonomous_response` 离线回应虽不消耗 LLM token，仍属已交付消息，计 1 条）；每次批量导入上报 `chrono_bulk_knowledge_import_item`，便于按 Stripe Meter Events 做超额计费。

**订阅闸门**：`active / trialing / past_due-within-grace` → 放行；其他 → HTTP 402 + actionable `upgradeUrl`。

**试用期**：Checkout 接受 `trialDays`，最长 90 天。
**退款**：admin 端点 `POST /api/v1/admin/billing/refund`，通过 Stripe Refunds API 反向打款。
**自助退订**：Customer Portal 集成完成（webhook 同步 cancel_at_period_end）。

---

## API 摘要（Phase 1 关键端点）

```
管理（admin JWT）
  GET    /api/v1/admin/persona-templates                  列出 + 内置 + 自定义
  GET    /api/v1/admin/persona-templates/:id/variables    枚举模板需要填充的 placeholder
  POST   /api/v1/admin/persona-templates/:id/instantiate  实例化为 persona

  POST   /api/v1/admin/billing/refund                     管理员退款

人格（用户 JWT）
  POST   /api/v1/persona-core/:personaId/conversations/messages          同步对话
  POST   /api/v1/persona-core/:personaId/conversations/messages/stream   SSE 流式
  GET    /api/v1/persona-core/:personaId/conversations/sessions/:sid     会话历史
  DELETE /api/v1/persona-core/:personaId/conversations                   GDPR 删除

  POST   /api/v1/persona-core/:personaId/bulk-knowledge-imports          提交批量导入
  GET    /api/v1/persona-core/:personaId/bulk-knowledge-imports/:jobId   查询 job

计费（用户 JWT）
  GET    /api/v1/billing/plans                            列出计划
  POST   /api/v1/billing/checkout                         创建 Stripe Checkout（含 trialDays）
  POST   /api/v1/billing/portal                           客户门户
  GET    /api/v1/billing/usage                            当前用量
  GET    /api/v1/billing/entitlements                     有效权益
```

完整 API 列表见路由模块文档。

---

## 迁移指南

### 从旧 simulation 业务迁移

旧业务的 `pro` 计划被声明为 `starter` 的 legacy 别名，**所有 `plan_id='pro'` 的现有订阅继续有效**，无需手动迁移。

新订阅请使用 `starter` ID。客户后台的 plan 切换可保留 `pro` 作为兼容 ID 直到下一次大版本（建议 6 个月后下线）。

### 从 v0.x 服务端升级

- 数据库迁移自动应用（v014 → v066）。生产环境升级前请：
  1. 备份数据库（PITR + 显式 dump）
  2. 在 staging 完整跑一遍 `npm run test:golden`
  3. 蓝绿部署，新版本健康检查通过后切流
- 配置：参考 [部署清单](../operations/p1-deployment-checklist.md) 12-13 项中的环境变量；Stripe Live key 通过 KMS 注入

---

## 已知限制

| 限制 | 计划改进 |
|------|---------|
| ValueGuard 关键词匹配在中英文混合的"软违规"场景仍可能漏判 | 注入 LLM 分类器（已支持，需提供 ClassifierProvider 实现） |
| 知识检索为关键词 + 可选 embedding 重排；超过 1000 条 / persona 性能下降 | 后续接入持久化向量索引（与 EmbeddingIndex 集成） |
| 流式 LLM 当前是"伪流式"（完整响应分块吐出） | 引入真流式需 ModelRouter `chatStream` provider 实现，已留 contract |
| 服务端 history 不持久化，由调用方传递 | 设计选择；如需持久化历史请实现外部 sessions store |
| Phase 1 不含 BYOK / BYOS 客户的隔离 | 已有基础设施（`tenant_enterprise_profiles`），enterprise 计划上线时启用 |
| LLM 成本数据存储但无可视化 dashboard | 暴露 `/admin/billing/usage` API 给前端实现 |

---

## 路线后续

| 时间 | 阶段 | 内容 |
|------|------|------|
| M3-M4 | Phase 2 批次 1 | src/core/* 服务层 UoW 迁移（为多运行时铺路）|
| M3-M5 | Phase 2 批次 2-3 | identity / enterprise 模块 UoW 迁移 |
| M4-M6 | **Phase 3 P3-A** | 工具权限模型 + AgencyAuthorization |
| M5-M7 | **Phase 3 P3-B** | MCP Server（人格作为 Claude / GPT 可调用工具）|
| M6-M8 | **Phase 3 P3-C** | 外部工具适配器（WebSearch / Calendar / Email）|
| M8-M10 | Phase 4 P4-A | Persona Portable Format (PPF) v1 规范 |
| M10+ | Phase 4 P4-B/C | @chrono/kernel 开源 + 多运行时适配器 |

---

## 下载

- 服务端：私有 NPM `@chrono/server`（基于 commit `c8a6ae9`）
- API SDK：建议从 OpenAPI spec 自动生成（`/api/v1/openapi.json` 路由 — 待补）
- Stripe 配置脚本：[`docs/operations/stripe-setup.md`](../operations/stripe-setup.md)

---

## 致谢

Phase 1 包含的全部承诺：T0-A `commitImport` / T0-B AI 安全治理 / P1-A 模板 / P1-B 知识批量 / P1-C 对话生产级（14 项加固）/ P1-D Stripe 真实订阅。

由 Claude (Sonnet 4.6) 与 ChronoSynth 工程团队联合实施，代码主权归 ChronoSynth。
