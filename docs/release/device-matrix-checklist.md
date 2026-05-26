# Device + Browser Matrix Checklist — v2.0.0 GA

**目标**：在 `chrono-synth-beta.wontlost.com`（NAS + CF Tunnel）上跑跨设备/浏览器矩阵，
确认登录、JWKS、admin/audit、tool 流程在所有目标客户端等价工作。

> 这是 NAS-01~06 的 device-axis 延展。NAS-01~06 已经在 chrono 服务器侧验过，本表只关心**客户端兼容性**。

---

## 客户端矩阵

| ID | 设备 | OS | 浏览器 | 优先级 |
|----|------|----|----|--------|
| C1 | MacBook | macOS 14+ | Safari (latest) | P0 |
| C2 | MacBook | macOS 14+ | Chrome (latest) | P0 |
| C3 | MacBook | macOS 14+ | Firefox (latest) | P1 |
| C4 | iPhone 12 | iOS 17+ | Safari mobile | P0 |
| C5 | iPad mini 5 | iPadOS 17+ | Safari | P1 |
| C6 | Oracle Cloud Linux VM | OL9 | curl + headless（验证非 GUI 路径） | P1 |

`P0` 是 GA 阻断；`P1` 不阻断 GA，但发现问题要记录到 GA-blockers backlog。

---

## 测试用例（每个客户端跑一次）

### M-01 健康检查 + JWKS（无需登录）

**步骤**：在浏览器打开
- `https://chrono-synth-beta.wontlost.com/healthz`
- `https://chrono-synth-beta.wontlost.com/.well-known/jwks.json`

**预期**：
- `/healthz` 返回 `{"status":"ok",...}`
- `/.well-known/jwks.json` 返回 `{"keys":[{...}]}` 至少一把 RS256
- 无证书警告 / 无 CORS 错误（开 devtools 看 Network）

**记录**：HTTP status / TLS 版本（在 Safari Web Inspector → Connection 里看）

---

### M-02 登录 → 拿 JWT

**步骤**：
1. 打开 `https://chrono-synth-beta.wontlost.com/`（或 `/login`）
2. 用 NAS beta 测试账号登录
3. devtools → Application → Cookies + Storage → 确认 JWT 落地（或 Authorization header）

**预期**：
- POST `/api/v1/auth/login` 返回 200 + JWT
- JWT header 含 `kid`（验热轮换可见）
- 后续 `/api/v1/*` 请求带 `Authorization: Bearer <jwt>`

**已知坑**：iOS Safari 在跨 subdomain 的 cookie 有 SameSite=None + Secure 要求。CF Tunnel 是 HTTPS 直通，应该 OK，但要验。

---

### M-03 Admin Tools 列表

**步骤**：登录后访问 `/admin/tools` 页面（或直接 fetch `/api/v1/admin/tools`）

**预期**：
- 200 + JSON 列表
- 浏览器渲染表格 / JSON 树
- 无 CSP 报错（devtools Console）

---

### M-04 Audit Log 查询

**步骤**：访问 `/admin/audit` 或 `GET /api/v1/admin/audit?limit=10`

**预期**：
- 200 + audit row 列表（至少包含 M-02 登录事件）
- 时间戳是 ISO 8601（UTC）

---

### M-05 Tool Invocation（端到端冒烟）

**步骤**：从 admin UI 触发一个 tool（或 `POST /api/v1/tool-invocations` with 一个 mock tool）

**预期**：
- 200 + invocation id
- audit log 立即出现新 row（M-04 重查）

**这条最容易暴露移动端坑**（CORS / fetch credentials / WebSocket if applicable）。

---

## 浏览器控制台探针脚本

把下面整段贴到 devtools Console 跑一遍，自动检查 M-01~M-04：

```javascript
// matrix-probe.js — 贴到 https://chrono-synth-beta.wontlost.com/ 控制台
(async () => {
  const BASE = 'https://chrono-synth-beta.wontlost.com';
  const log = (k, v) => console.log(`[matrix-probe] ${k}:`, v);
  const fail = (k, e) => console.error(`[matrix-probe] ❌ ${k}:`, e);

  // M-01a: healthz
  try {
    const r = await fetch(`${BASE}/healthz`);
    log('M-01a healthz', `${r.status} ${(await r.json()).status}`);
  } catch (e) { fail('M-01a', e); }

  // M-01b: JWKS
  try {
    const r = await fetch(`${BASE}/.well-known/jwks.json`);
    const j = await r.json();
    log('M-01b JWKS', `${r.status} keys=${j.keys?.length}`);
  } catch (e) { fail('M-01b', e); }

  // 需要登录后再跑的部分（从 localStorage / sessionStorage / cookie 拿 token）
  const tok = localStorage.getItem('jwt') || sessionStorage.getItem('jwt');
  if (!tok) {
    log('M-02', '⚠️ 未登录，跳过 M-03/M-04（请先登录）');
    return;
  }
  const H = { Authorization: `Bearer ${tok}` };

  // M-03: admin/tools
  try {
    const r = await fetch(`${BASE}/api/v1/admin/tools`, { headers: H });
    log('M-03 admin/tools', `${r.status}`);
  } catch (e) { fail('M-03', e); }

  // M-04: admin/audit
  try {
    const r = await fetch(`${BASE}/api/v1/admin/audit?limit=5`, { headers: H });
    const j = await r.json();
    log('M-04 admin/audit', `${r.status} rows=${j.items?.length ?? j.length}`);
  } catch (e) { fail('M-04', e); }
})();
```

把 console 输出截图，每客户端一张，附到本文档 § 结果矩阵。

---

## 结果矩阵（待填）

| ID | M-01 | M-02 | M-03 | M-04 | M-05 | 备注 |
|----|------|------|------|------|------|------|
| C1 macOS Safari | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| C2 macOS Chrome | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| C3 macOS Firefox | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| C4 iPhone 12 Safari | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| C5 iPad mini 5 Safari | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | |
| C6 Oracle VM curl | ⏳ | ⏳ | N/A | N/A | N/A | 只跑 M-01 |

**图例**：✅ 通过 / ⚠️ 通过但有警告 / ❌ 失败 / ⏳ 未测 / N/A 不适用

---

## 通过标准

- 所有 P0（C1, C2, C4）的 M-01~M-04 = ✅
- M-05 至少在 C1 + C4 各跑一遍 = ✅
- P1 失败可降级为 GA-after-1.0.1 backlog

**全部 P0 ✅ → 可以打 v2.0.0 GA tag。**

---

**报告生成**：起草 2026-05-26
**报告作者**：Claude Code（AI 协作）
**关联**：`internal-beta-report.md`, ADR-0046
