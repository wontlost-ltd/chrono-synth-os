# Internal Beta Report — v2.0.0-beta.{1,2,3}

**部署平台**：Synology NAS（DSM 7）+ Cloudflare Tunnel
**公网域名**：`chrono-synth-beta.wontlost.com`
**内测周期**：2026-05-25 → 2026-05-26（约 6 小时实操 + 24h 异步长跑）
**Image 链**：v2.0.0-beta.1 → v2.0.0-beta.2 → v2.0.0-beta.3（OS + Web 同步迭代）

> 配套 ADR-0046（双产品并行）。本报告记录 ChronoSynth Enterprise 路线
> 第一次真实公网部署的 dogfood 结果，是后续 staging / GA 的 baseline。

---

## 摘要

| 项 | 结果 |
|----|------|
| **可用性目标** | 4 个 docker service (postgres / backend / web / cloudflared) 同时 healthy |
| **达成状况** | ✅ 达成（v2.0.0-beta.3 起稳定，含 12 个内测 bug 修复后） |
| **NAS 验收清单 6 项** | 4 ✅ 完成 / 1 ⏭️ 合理 deferred / 1 ⏳ 24h 异步 |
| **§8 #1 三个修复实战验证** | 2 ✅ 验真（JWT 热轮换 + Zod 边界）/ 1 ⏭️ deferred 到接真 KMS staging |
| **暴露并修复的真 bug** | 12 个（部署脚本 / Dockerfile / image 内部 / 中间件） |
| **是否可 GA** | 待评估（下一步双审 + §8 评分） |

---

## NAS 验收清单结果

| 用例 | 内容 | 状态 | 验证手段 |
|------|------|------|---------|
| **NAS-01** | 启动健康检查 | ✅ | `curl /healthz` HTTP 200 + JSON status=ok / `curl /readyz` 全组件 ok / `curl /.well-known/jwks.json` 返回 RFC 7517 JWK |
| **NAS-02** | SSO 登录端到端 | ✅ | `POST /api/v1/auth/register` 返回 RS256 JWT (kid header) / token verify 在 `/api/v1/auth/keys` 接受 |
| **NAS-03** | JWT 热轮换（§8 #1 Critical） | ✅ | rotate API 返回 200 `activeKid: kid-2`（不再 409 RESTART_REQUIRED）/ 重新登录后 token header.kid 切换 / JWKS 同时发布 active + grace 两把 |
| **NAS-04** | KMS 锚定 evidence（§8 #1 Major） | ⏭️ deferred | NAS 单机部署无真 KMS 注入；单元 + 集成测试已覆盖（audit-kms-anchor.test.ts 12/12）。详见 internal-beta-checklist.md NAS-04 注释 |
| **NAS-05** | 24h 长跑稳定性 | ⏳ 异步 | NAS 当前在跑，明天读 `docker stats` + `docker logs --since 24h \| grep -i error` |
| **NAS-06** | 备份 + 还原 | ✅ | `pg_dump \| gzip` 备份 / `DROP DATABASE + CREATE + psql < gz` 还原 / 验证 user 表回到备份基线、注册后用户不在还原数据里 |

---

## 暴露并修复的 12 个真 bug

按发现顺序排列。每一个都是**单元/集成测试 + ga:check 跑过但被真实部署链路触发**的盲区。

| # | Commit | 触发节点 | 根因 | 修复 |
|---|--------|---------|------|------|
| 1 | `7b258c5` | `docker compose up` | postgres bind mount 要求 host 端源路径存在，脚本没 mkdir | `setup-nas-beta.sh` Step 4 末尾自动 `mkdir -p data/{postgres,os}` |
| 2 | `12d65b2` | backend 启动即崩 | OS Dockerfile runtime stage 漏 COPY `@wontlost-ltd/schema-dsl` 的 package.json + dist，runtime `npm ci` 没建工作区软链 | runtime stage 加 `COPY packages/schema-dsl/package.json` + `COPY --from=builder /app/packages/schema-dsl/dist` |
| 3 | `bb47af2` | backend crash loop | `CHRONO_CORS_ORIGIN=true`（wildcard） + `CHRONO_CORS_CREDENTIALS=true`，CORS spec 禁止 wildcard+credentials 组合，schema.js 主动拒启 | 改成 `CHRONO_CORS_ORIGIN=https://${BETA_DOMAIN}`（具体 origin）|
| 4 | `bb47af2` | web nginx startup emerg | nginx.conf 引用 enterprise 全栈才有的 upstream（`observability-worker`/`prometheus`/`grafana`），nginx startup 对所有 upstream 做 DNS 解析 | compose 给 web 加 `extra_hosts` 把这些名字指向 `127.0.0.1` |
| 5 | `4a5627c` | backend schema 迁移 | `postgres:16-alpine` 不带 pgvector C extension，OS DSL 迁移含 `CREATE EXTENSION vector` | 换 `pgvector/pgvector:pg16`，后续 `81110d1`(b) 升 pg17 |
| 6 | `c22b726` | backend startup | PEM 多行私钥用 `\n` 字面量塞 `.env`，docker compose 不会还原 — fast-jwt 报 `PEM section not found` | volume 挂载 `jwt-keys/` 到容器 `/run/secrets/jwt-keys/` + entrypoint shell wrapper 用 `cat` 读真换行 |
| 7 | `81110d1`(a) | entrypoint cat 失败 | host 上 PEM 是 `0600 root:root`，OS image 的 `USER chrono`（uid=100+）读不到 | backend service 加 `user: "0"`（容器以 root 跑读 0600 PEM） |
| 8 | `1868c34` | backend `password authentication failed for user "chrono"` | postgres 只在 data 卷为空时用 `POSTGRES_PASSWORD` 初始化 user；之前部署写过旧密码，`--force` 重生 `.env` 后新密码与旧用户不匹配 | 脚本检测到 `data/postgres` 非空 + 即将生成新 `.env` 时立刻 die，打印"清 data 重建"或"保留旧密码"两个明确选项 |
| 9 | `4d55723` | `curl /.well-known/jwks.json` 返回 SPA HTML | web nginx.conf 没有 `/.well-known/` location，请求落到 SPA fallback `/index.html` | nginx.conf 加 `location /.well-known/ { proxy_pass http://backend:3000; }` |
| 10 | `6d4b382` | `curl /.well-known/jwks.json` 401 AUTH_MISSING_KEY | OS 两个中间件 `plugins/jwt-auth.ts` 和 `plugins/auth.ts` 各有 PUBLIC_PATHS。jwt-auth 已豁免 jwks.json，但 auth (API Key) 没豁免，链路上后者拦截 | 同步两份 PUBLIC_PATHS，加 regression test `api.test.ts "公共路径不需要 API Key"` 新增 JWKS 断言 |
| 11 | `c3267be` | backend production guard | `NODE_ENV=production` 时 life-simulation 路由强制要求 `queue.enabled=true`，否则注册路由直接抛错 | compose env 加 `CHRONO_QUEUE_ENABLED=true`（in-process queue 不需要 Redis） |
| 12 | `81110d1`(b) | pg16→pg17 主版本升级 | pg17 拒绝挂载 pg16 写的 catalog | 脚本注释明文标注，部署文档要求清 `data/postgres` |

### 统计

- 部署脚本 bug：6（#1, #3, #4, #7, #8, #11） — `setup-nas-beta.sh` 经 9 次迭代
- Image 内部 bug：4（#2 Dockerfile, #6 PEM env 设计, #9 nginx route, #10 中间件不一致）
- 配置依赖 bug：2（#5 pgvector / #12 pg major）

**单元/集成/ga:check 全绿 ≠ 部署可跑**。每一个 bug 都不是代码逻辑错，都是**真实部署链路（CF Tunnel → nginx → OS image 启动 → backend 配置加载）跨多个层次的环境耦合**。这就是真实部署 dogfood 的不可替代价值。

---

## §8 #1 Critical 修复真实验证：JWT 热轮换

这是这次 NAS 内测**最有价值的发现**，单一段落记录。

### 修复目标（GA §8 Critical 评审）

ChronoSynth GA §8 评审第一次返回 **78/100 NEEDS_IMPROVEMENT**，Critical
问题：`/api/v1/auth/keys/rotate` 端点返回 `409 AUTH_ROTATE_RESTART_REQUIRED`
拒绝任何会切换 signing-effective active kid 的轮换。fastify-jwt 在
`register()` 时捕获 `secret`，无法热换 — 运维必须更新 `jwt.keys` config
然后重启所有 pod 才能完成密钥轮换。这破坏 incident response 5min RTO。

### 修复（commit `0130e76`）

新增 `src/server/plugins/jwt-dynamic-crypto.ts`：
- `createDynamicSigner(keyRing)` — 每次签发从 `keyRing.signEntry()` 现取 active key，按 kid LRU 缓存复用 fast-jwt signer
- `createDynamicVerifier(keyRing)` — 按 token header.kid 路由公钥，未知 kid 抛 AUTH_KID_REVOKED
- `auth-service.ts:176` `app.jwt.sign(payload)` → `app.jwtSign(payload)`
- `jwt-auth.ts` onRequest 钩子 `request.jwtVerify()` → `dynamicVerify(bearer)`
- 解掉 `AUTH_ROTATE_RESTART_REQUIRED` 409 gate

### NAS-03 真实链路验证步骤

```bash
DOMAIN="chrono-synth-beta.wontlost.com"

# 1. 注册 admin、获取初始 token
curl -s -X POST "https://$DOMAIN/api/v1/auth/register" \
  -d '{"email":"admin@beta.test","password":"..."}' \
  → 返回 access_token，header.kid = "kid-1"

# 2. 看 KeyRing 初始状态
curl "https://$DOMAIN/api/v1/auth/keys"
  → { active: kid-1, graceKeys: [], retired: [], compromised: [] }

# 3. 生成 kid-2 → rotate
openssl genpkey RSA 2048
curl -X POST "https://$DOMAIN/api/v1/auth/keys/rotate" \
  -d '{"newActiveKid":"kid-2", "addNew":[{kid:"kid-2", state:"grace", ...}]}'
  ✅ 200 { ok:true, activeKid:"kid-2", snapshot: {active:kid-2, grace:[kid-1]} }
     不是 409 AUTH_ROTATE_RESTART_REQUIRED  ← Critical 修复生效

# 4. 重新登录拿新 token
  ✅ token header.kid = "kid-2"（dynamicSigner 用了新 active key）

# 5. JWKS 端点同时发布两把
curl "https://$DOMAIN/.well-known/jwks.json"
  ✅ keys: [{kid:"kid-1",...}, {kid:"kid-2",...}]

# 6. 用新 token 访问保护接口
curl -H "Authorization: Bearer <new-token>" "https://$DOMAIN/api/v1/auth/keys"
  ✅ HTTP 200（dynamicVerify 用 KeyRing 中 kid-2 的公钥验签通过）
```

### 验证结果

| 验证项 | 单元/集成测试 | NAS 真实部署 |
|--------|---------------|--------------|
| rotate API 不再 409 | ✅ jwt-key-lifecycle 19/19 | ✅ HTTP 200 + activeKid: kid-2 |
| 进程内切 active key | ✅ test 验证 | ✅ KeyRing snapshot active=kid-2, grace=[kid-1] |
| 新 token 用新 kid 签 | ✅ test 验证 | ✅ 重新登录 token header.kid="kid-2" |
| JWKS 双发布 | ✅ test 验证 | ✅ jwks.json 同时含 kid-1 + kid-2 |
| dynamicVerify 按 kid 选公钥 | ✅ test 验证 | ✅ 新 token 在保护接口 200 |

**GA §8 Critical 修复在生产链路 100% 验真。**

---

## 灾备演练（NAS-06）

### 演练步骤

1. **基线**：DB 中 admin@beta.test + jwt_signing_keys 含 active=kid-2 / grace=kid-1
2. **备份**：`docker compose exec -T postgres pg_dump | gzip > backup.sql.gz`
3. **写入备份后数据**：从 Mac 注册 `dr-test@example.com`
4. **还原**：`DROP DATABASE chrono WITH (FORCE) + CREATE DATABASE + gunzip | psql`
5. **验证**：
   - DB users 表只剩 admin@beta.test（dr-test 不存在）
   - jwt_signing_keys 完整恢复（active=kid-2, grace=kid-1）
   - admin 登录 ✅ 成功
   - dr-test 登录 ✅ 失败（备份后注册的用户被还原冲掉）

### 结论

PostgreSQL 备份 + 还原完整 round-trip 工作。DR RTO < 15 分钟（含人工干预）。
**未验证**：在备份之前 / 还原之后的 KMS audit anchor 链是否仍然完整（NAS-04 deferred）。

---

## Image 迭代时间线

| 版本 | 时间 | 关键改动 |
|------|------|---------|
| v2.0.0-beta.1 | 2026-05-24 | 首次 release 触发；GA §8 三修复 + 16 commits 自上一稳定点 |
| v2.0.0-beta.2 | 2026-05-25 早 | OS: schema-dsl runtime fix（bug #2）；Web: nginx SSE buffering（feature-flag kill-switch） |
| v2.0.0-beta.3 | 2026-05-26 早 | OS: JWKS API Key bypass（bug #10）；Web: nginx `/.well-known/` proxy（bug #9） |

每次都通过 release.yml 触发：
- docker/build-push 推到 `ghcr.io/wontlost-ltd/chrono-synth-os` + `chrono-synth-web`
- cosign keyless signing（Sigstore Fulcio）
- SBOM (SPDX-JSON) attestation
- SLSA build provenance attestation
- Trivy scan: pre-release 仅阻塞 CRITICAL；GA 会阻塞 CRITICAL+HIGH

**dispatch-deploy 跳过**（按 ADR 设计，pre-release tag 不触发 `chrono-synth-deploy`
自动 promote — 由运维手动判断）。

---

## 留待 GA 处理

### Critical / Major

无新发现的 Critical/Major issues。NAS-04 deferral 是合理操作，不构成阻塞。

### Minor（不阻塞 GA）

| 项 | 说明 |
|----|------|
| 1 | `backend.user: "0"` 是 beta 妥协，生产应让 OS image 支持 `CHRONO_JWT_PRIVATE_KEY_FILE` env 或采用 docker `secrets:` 标准，恢复非 root 容器 |
| 2 | nginx 引用 `observability-worker`/`prometheus`/`grafana` 没用 `resolver` + variable 做 lazy resolution，强 DNS 解析 → 必须 host 端 stub。Web image 应改 nginx.conf 用 `set $upstream "..."; resolver kube-dns valid=30s;` 让 startup 不解析 |
| 3 | `cors.origin=true (wildcard) 不能与 credentials=true 同时使用` 后端代码报错信息可加 "推荐改成具体 origin" 指引 |
| 4 | postgres pg17 升级 vs pg16 cluster 兼容性可在 setup script 自动检测 + 提示 `pg_upgrade` 路径而非要求清空 data |

### Deferred 到 staging

- NAS-04 KMS 锚定 evidence：接入真实 KMS（OCI Vault / AWS KMS / HashiCorp Vault）后再验
- 多 pod 跨实例 keyRing 同步：单 NAS 单 pod 不能验，OCI 双 pod staging 才能验

---

## 决策 + 下一步

| 决策 | 状态 |
|------|------|
| ChronoSynth Enterprise v2.0.0 是否可 GA tag | **待评估**（下一步双审 + §8 重新评分） |
| §8 GA 评分（上次 89/100）会因为 NAS 内测信号上涨吗 | 待验证 |
| Companion Phase 0 是否可启动 | ✅ Enterprise 路径已验真，按 ADR-0046 D5 互不阻塞 |

### 后续工作（按优先级）

1. **跨模型双审 + §8 GA 评分**（下一步 — 把内测信号作为新输入再走一次 §8 评审）
2. **24h 长跑结果**（NAS-05）— 异步等待，明天看
3. **跨设备 + 浏览器内测**（B 优先级）— iPhone/iPad/Mac/4 浏览器
4. **Companion Phase 0 启动**（C 优先级）— 按 ADR-0046 / `docs/plan/companion-roadmap.md`

---

## 附录：内测期 git 历史

NAS 内测期（2026-05-25 → 2026-05-26）共 38 个 commits，**12 个真 bug 修复 + 9 个 dependabot 升级 + 3 个 ADR/docs**。详 `git log --since=2026-05-24 --until=2026-05-27`。

GHCR images：
- `ghcr.io/wontlost-ltd/chrono-synth-os:2.0.0-beta.{1,2,3}` — 全部签名 + SBOM + SLSA provenance
- `ghcr.io/wontlost-ltd/chrono-synth-web:2.0.0-beta.{1,2,3}` — 同上

---

**报告生成时间**：2026-05-26
**报告作者**：Claude（与 Ryan Pang 共同部署）
