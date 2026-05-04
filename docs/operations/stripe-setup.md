# Stripe Dashboard 配置指南（Phase 1 上线必备）

> 目标读者：运营 / DevOps；前提是已有 Stripe Standard 账户。
> 完成本文所有步骤后，ChronoSynth OS Phase 1 商业化路径才完整可用。
>
> 本文涉及的服务端 commit 基线：`c8a6ae9`（feat(billing): P1-D production Stripe subscriptions）

---

## 0. 前置准备

| 项 | 说明 |
|---|------|
| Stripe 账户 | 已激活，开通 Subscriptions 与 Meter Events（Beta 功能可能需额外申请）|
| 品牌资料 | 在 Stripe Dashboard → Settings → Branding 完成 logo / 主题色（Customer Portal 显示用）|
| 域名 | 业务前端域名已通过 SSL 部署；用于 success_url / cancel_url / portal return_url |
| 服务端版本 | `c8a6ae9` 或更新 |

---

## 1. 创建 Products 与 Prices

在 Stripe Dashboard → **Products** 下创建以下条目：

### 1.1 Starter（基础版）

| 字段 | 值 |
|------|------|
| Name | ChronoSynth Starter |
| Description | 5 personas, 5,000 conversation messages/mo, 5 GB knowledge |
| Price | $99.00 USD / month, recurring |
| Tax behavior | Inclusive 或 Exclusive（按业务税务策略选）|
| Trial period | 不在 Price 上配置；通过 API 传递 `trial_period_days`（动态控制）|

创建完成后记录 Price ID（形如 `price_1Q...`），后续注入环境变量 `CHRONO_STRIPE_PRICE_STARTER`。

### 1.2 Growth（专业版）

| 字段 | 值 |
|------|------|
| Name | ChronoSynth Growth |
| Description | 25 personas, 50,000 conversation messages/mo, 50 GB knowledge |
| Price | $499.00 USD / month, recurring |

记录 Price ID 注入 `CHRONO_STRIPE_PRICE_GROWTH`。

### 1.3 Enterprise（企业版）

| 字段 | 值 |
|------|------|
| Name | ChronoSynth Enterprise |
| Description | Custom limits + dedicated support |
| Price | Custom（不在 Stripe 上设固定价；通过 Stripe Sales-led flow 走自定义合同 + Quote）|

可选：创建一个 placeholder Price（如 $0/month）以走 Checkout，再在 webhook 收到 invoice 后由运营手动调整金额。注入 `CHRONO_STRIPE_PRICE_ENTERPRISE`。

### 1.4 Legacy `pro` 计划（如有历史用户）

如已在生产环境有 `pro` 计划订阅：保留原 Stripe Price 不变，在环境变量注入 `CHRONO_STRIPE_PRICE_PRO`。代码中 `pro` 已声明为等同 `starter` 的 legacy 别名。

---

## 2. 注册 Meter Events（用量计费）

ChronoSynth 通过 Stripe Meter Events 上报对话与知识导入的实际用量，便于做"包月 + 超额按量"组合计费。

### 2.1 创建 Meters

在 Stripe Dashboard → **Billing → Meters**（Beta）创建：

| Display name | Event name (服务端发送时使用) | Aggregation | Default |
|--------------|------------------------------|-------------|---------|
| Conversation messages | `chrono_conversation_message` | Sum | 0 |
| Bulk knowledge imports | `chrono_bulk_knowledge_import_item` | Sum | 0 |

事件 payload 规范（服务端自动遵守）：

```jsonc
{
  "event_name": "chrono_conversation_message",
  "payload": {
    "stripe_customer_id": "cus_...",
    "value": "1"
  }
}
```

### 2.2 把 Meters 关联到 Price 的 usage_type=metered（可选）

如要按"超额"计费（如 `Starter $99 包含 5000 条，超出每条 $0.005`），创建额外的 metered price：

1. Stripe Dashboard → 进入对应 Product → **Add another price**
2. Pricing model: **Usage-based / Metered**
3. Meter: 选择上一步创建的 `chrono_conversation_message` meter
4. Price per unit: $0.005（示例）
5. Aggregation: Sum

把这个 metered price 加到订阅的 line_items 里（需要扩展服务端 `createCheckoutSession`，当前实现仅传 1 个 base price）。如本期不上线超额计费，跳过此步骤。

---

## 3. Webhook 配置

### 3.1 创建 Webhook Endpoint

在 Stripe Dashboard → **Developers → Webhooks → Add endpoint**：

| 字段 | 值 |
|------|------|
| Endpoint URL | `https://<your-domain>/api/v1/billing/webhook` |
| Description | ChronoSynth Phase 1 production |
| API version | 锁定到 `2025-01-27.acacia`（与服务端 SDK 一致）|
| Events to send | 见下表 |

### 3.2 订阅以下事件（必填）

| 事件 | 必要性 | 说明 |
|------|--------|------|
| `customer.subscription.created` | 必填 | 订阅创建后写 status / plan_id |
| `customer.subscription.updated` | 必填 | trial → active 转换、取消标记同步 |
| `customer.subscription.deleted` | 必填 | 触发 free 计划降级 + add-on 清理 |
| `customer.subscription.trial_will_end` | 必填 | 试用 3 天前提醒；当前服务端仅记录 webhook_events，业务侧通知由订阅消费 |
| `invoice.paid` | 必填 | past_due → active 恢复 |
| `invoice.payment_succeeded` | 必填 | 别名，与 invoice.paid 等价处理 |
| `invoice.payment_failed` | 必填 | active → past_due，3 天宽限期 |

不订阅以下事件（避免噪声）：
- `payment_intent.*`（不直接消费；invoice 事件已足够）
- `charge.*`（同上）
- `customer.created/updated/deleted`（服务端用 metadata.tenantId 维护映射）

### 3.3 记录 Signing Secret

创建后会显示 `whsec_...`，注入环境变量 `CHRONO_STRIPE_WEBHOOK_SECRET`。

---

## 4. Customer Portal 配置

Stripe Dashboard → **Settings → Billing → Customer portal**：

| 模块 | 推荐设置 |
|------|----------|
| Branding | 同 §0 全局品牌；设置 support email |
| Functionality – Cancel subscription | ✅ 启用；模式 `Cancel at period end`（避免立刻断服）|
| Functionality – Switch plans | ✅ 启用；切换目标限定 starter / growth |
| Functionality – Update payment method | ✅ 启用 |
| Functionality – View invoices | ✅ 启用 |
| Privacy & terms | 链接到产品 Terms / Privacy 页 |

完成后保存。Portal Session 会自动使用此配置。

---

## 5. 服务端环境变量映射

将所有上文获得的 ID / Secret 注入服务端运行环境。env 名以 `CHRONO_` 前缀（已和 `loadConfig` 默认对接）：

```bash
# .env.production (示例，生产请使用密钥管理服务而非明文文件)
CHRONO_STRIPE_ENABLED=true
CHRONO_STRIPE_SECRET_KEY=sk_live_...
CHRONO_STRIPE_PUBLISHABLE_KEY=pk_live_...
CHRONO_STRIPE_WEBHOOK_SECRET=whsec_...

CHRONO_STRIPE_PRICE_STARTER=price_1Q...starter
CHRONO_STRIPE_PRICE_GROWTH=price_1Q...growth
CHRONO_STRIPE_PRICE_ENTERPRISE=price_1Q...enterprise
# Legacy（如有 pro 历史订阅）
CHRONO_STRIPE_PRICE_PRO=price_1Q...pro
```

---

## 6. 端到端验证（沙盒）

### 6.1 测试卡号

| 场景 | 卡号 |
|------|------|
| 成功支付 | `4242 4242 4242 4242` |
| 立即拒付 | `4000 0000 0000 0002` |
| 第一次成功 + 续订失败 | `4000 0000 0000 0341` |
| 触发 trial_will_end | 任意成功卡 + trial_period_days >= 3 |

### 6.2 验证清单

```bash
# 1) 拉取计划列表
curl -H "Authorization: Bearer $JWT" https://<domain>/api/v1/billing/plans
# 期望：返回 free/starter/growth/enterprise/pro 五项

# 2) 创建 Checkout（trial 14 天）
curl -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"priceId":"price_1Q...starter","successUrl":"https://app.example.com/billing/success","cancelUrl":"https://app.example.com/billing/cancel","trialDays":14}' \
  https://<domain>/api/v1/billing/checkout
# 期望：返回 sessionId + url；浏览器打开 url 完成支付

# 3) Stripe webhook 推送 customer.subscription.created → 验证 DB
psql $CHRONO_DB_URL -c \
  "SELECT plan_id, status, trial_end, stripe_subscription_id FROM subscriptions ORDER BY created_at DESC LIMIT 1"
# 期望：plan_id=starter, status=trialing, trial_end=now+14d

# 4) 试用期内调用对话 API（应放行）
curl -X POST -H "Authorization: Bearer $JWT" \
  -d '{"sessionId":"s1","messageId":"m1","externalUserId":"eu","content":"你好"}' \
  https://<domain>/api/v1/persona-core/<personaId>/conversations/messages
# 期望：200 OK + Stripe Meter Event chrono_conversation_message 入队

# 5) Meter Events 对账
# Stripe Dashboard → Billing → Meters → chrono_conversation_message → 查看最近事件

# 6) 模拟支付失败
# Stripe Dashboard → Customers → <test customer> → Cancel auto-renewal 或使用失败卡
# 服务端预期：status=past_due, grace_period_ends_at=now+3d；3d 内仍可调用对话 API；3d 后返回 402
```

---

## 7. 发布前最后检查

- [ ] Stripe Dashboard 切到 **Live mode**（不是 Test mode）
- [ ] 重新创建上述全部 Products / Prices / Meters / Webhook 在 Live mode（Test/Live 数据隔离）
- [ ] 服务端 `CHRONO_STRIPE_*` 环境变量切换到 Live key
- [ ] 验证 Webhook signature 校验：从 Stripe Dashboard 的 "Send test webhook" 按钮发送一个测试事件，服务端日志应显示 `webhook 处理成功`
- [ ] Customer Portal return_url 与 success_url / cancel_url 都指向 Live 域名
- [ ] 监控告警：`/readyz` 状态、`chrono_conversation_llm_failures_total`、Stripe Webhook delivery failures（Stripe 会主动重试，但应观察累计失败率）

完成后 Phase 1 即可对外销售。
