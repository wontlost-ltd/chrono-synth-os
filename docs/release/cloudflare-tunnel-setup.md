# Cloudflare Tunnel — chrono-synth-beta 接入设置

**用途**：在 Cloudflare Zero Trust dashboard 里建一个 tunnel，把 `chrono-synth-beta.wontlost.com` 的流量打到你 NAS 上的 cloudflared 容器。
**配套**：`setup-nas-beta.sh` 第三个参数 `<CF_TUNNEL_TOKEN>` 就来自这里。
**前置**：`wontlost.com` 已在 Cloudflare 的权威 DNS 下（你说已经是）。

---

## 整体流量路径回顾

```
浏览器
  https://chrono-synth-beta.wontlost.com
       ↓ (DNS：CNAME 指向 <tunnel-id>.cfargotunnel.com)
  Cloudflare edge (TLS 终结在 CF，证书 CF 自动签)
       ↓ (CF 内部加密通道)
  cloudflared 容器 (在你 NAS docker 内，主动连出去到 CF edge，无入站端口)
       ↓ (docker 内部网络 http)
  web 容器 :8080 (nginx)
       ↓ (proxy_pass /api/* 到 backend:3000)
  backend 容器 :3000 (chrono-synth-os)
```

**优点**：
- NAS 上**不开任何公网端口**（80/443/任何）— 路由器 NAT 不需要改
- 证书全部 CF 管，永不过期
- DDoS / 爬虫流量 CF 边缘拦截
- 内置 4 条 HA 连接，单条断开不影响服务

---

## 第 1 步：进 Cloudflare Zero Trust dashboard

1. 登录 https://one.dash.cloudflare.com/
2. 顶部选择 account **wontlost-ltd**（或 wontlost.com 所属的 account）
3. 左侧栏 → **Networks** → **Tunnels**
4. 右上角 **Create a tunnel**

---

## 第 2 步：创建 tunnel

| 字段 | 值 |
|------|-----|
| **Connector type** | `Cloudflared` |
| **Name** | `chrono-synth-beta-nas` |

> **不要** 选 WARP Connector。WARP 是用于把 NAS 当 WARP 客户端访问 CF 内网的方向，反了。

点 **Save tunnel**。

---

## 第 3 步：复制 token

页面会跳到 "Install and run a connector"。选 **Docker** 那个 tab，会看到一行命令：

```bash
docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoiYWJjZGVmZ2hpams...一长串
```

**只复制 `--token` 后面那一长串字符**（一般 200+ 字符）。这就是 `setup-nas-beta.sh` 的第三个参数。

> ⚠️  这个 token 是 tunnel 的全部凭据。任何人拿到都能伪装成你的 tunnel。**不要 commit，不要分享**。
> 内测期间如果泄露，回 dashboard 删除 tunnel 重建即可。

不要在这一页点 **Next** 直接走完 wizard —— 我们要从命令行启 cloudflared，所以先复制 token + 把这一页放着。

---

## 第 4 步：配置 Public Hostname

在 CF dashboard 上**同一个 tunnel** 的页面（如果你已经过了 wizard，从左侧 Tunnels 列表点回 `chrono-synth-beta-nas`），切到 **Public Hostname** tab，点 **Add a public hostname**：

| 字段 | 值 |
|------|-----|
| **Subdomain** | `chrono-synth-beta` |
| **Domain** | `wontlost.com`（下拉里应该自动列出） |
| **Path** | （留空） |
| **Service Type** | `HTTP` |
| **URL** | `web:8080` |

> **关键**：`web:8080` 必须和 docker-compose.yml 里 service 名字一致。`setup-nas-beta.sh` 生成的 compose 用 `web` 作为 service name 不能改。

点 **Save hostname**。

CF 自动在 wontlost.com 的 DNS 里加一条 CNAME：

```
chrono-synth-beta.wontlost.com  →  <tunnel-id>.cfargotunnel.com  (proxied)
```

你不需要去 DNS 标签页手动改这条记录，CF Tunnel 自己管。

---

## 第 5 步：（可选）TLS / Origin 设置调优

进 **Public Hostname** 中刚加的那一行 → **Edit** → **Additional application settings**：

- **TLS** → **Origin Server Name**：留空（cloudflared 到 web 容器是 HTTP 不需要）
- **HTTP** → **HTTP/2 connection**：✅ 开（cloudflared 优先用 h2 提速）
- **Connection** → **Connect Timeout**：30s
- **Connection** → **TLS Timeout**：留默认

保存。

---

## 第 6 步：（强烈推荐）开 CF 端的额外保护

在主 dashboard（不是 Zero Trust） → 选 `wontlost.com` 区域：

1. **SSL/TLS** → **Overview** → 设为 **Full** （CF 与 origin 间也走 TLS；cloudflared 内部已经加密，所以这里设 Full 没坏处）
2. **Security** → **WAF** → **Managed Rules** → 启用 "Cloudflare Managed Ruleset"（免费 plan 也能开）
3. **Speed** → **Optimization** → **Brotli** → On
4. **Caching** → **Configuration** → 关闭对 `chrono-synth-beta.wontlost.com` 路径的缓存（API 响应不应被 CF 缓存）：
   - **Page Rules**（旧）→ 加一条 `chrono-synth-beta.wontlost.com/api/*` → Cache Level: Bypass
   - 或新的 **Configuration Rules**：URI Path contains `/api/` AND Hostname equals `chrono-synth-beta.wontlost.com` → Cache → Bypass cache

API 不 bypass 的话 CF 会缓存 GET 返回，登录态会跨用户漏。

---

## 第 7 步：回 NAS 跑 setup-nas-beta.sh

脚本只需要单文件，**不需要把整个 chrono-synth-os 仓 clone 到 NAS**。
任选下面一条路径：

### 选项 A（推荐 — 直接拉脚本，不 clone 仓库）

```bash
# 把脚本放到 NAS 上你方便管理的目录（不必和部署目录同级）
mkdir -p /volume2/docker/scripts
cd /volume2/docker/scripts

# 从 GitHub main 直接拉脚本
curl -fsSLO https://raw.githubusercontent.com/wontlost-ltd/chrono-synth-os/main/docs/release/scripts/setup-nas-beta.sh
chmod +x setup-nas-beta.sh

# 跑（部署目录 + 公网域名 + CF Tunnel token）
bash setup-nas-beta.sh \
  /volume2/docker/chrono-beta \
  chrono-synth-beta.wontlost.com \
  '<贴你的 CF Tunnel token>'
```

> 如果 GitHub 仓库是 private，`curl` 需要 PAT 认证：
> ```bash
> curl -fsSL -H "Authorization: token <你的 PAT>" \
>   -o setup-nas-beta.sh \
>   https://raw.githubusercontent.com/wontlost-ltd/chrono-synth-os/main/docs/release/scripts/setup-nas-beta.sh
> ```

### 选项 B（如果你想保留更新能力 — sparse-checkout 仓库）

只 clone 仓库里的 `docs/release/` 目录，避免拉 100MB 源码：

```bash
cd /volume2/docker
git clone --filter=blob:none --no-checkout \
  https://github.com/wontlost-ltd/chrono-synth-os.git
cd chrono-synth-os
git sparse-checkout init --cone
git sparse-checkout set docs/release
git checkout main

# 跑脚本（路径从仓库根开始）
bash docs/release/scripts/setup-nas-beta.sh \
  /volume2/docker/chrono-beta \
  chrono-synth-beta.wontlost.com \
  '<贴你的 CF Tunnel token>'

# 未来同步最新脚本 + 文档：
git pull origin main
```

> ⚠️ **token 一定要用单引号包**，避免 shell 把里面的 `$` 当变量展开导致 token 损坏。
> CF Tunnel token 长度通常 200+ 字符，复制时确认没截断。

脚本跑完后：

```bash
cd /volume2/docker/chrono-beta
sudo docker compose up -d
sudo docker compose ps        # 应该看到 4 个 service：postgres / backend / web / cloudflared
sudo docker compose logs cloudflared | tail -20
```

cloudflared 启动 5-15 秒会打印类似：

```
INF Registered tunnel connection connIndex=0 location=SJC
INF Registered tunnel connection connIndex=1 location=SJC
INF Registered tunnel connection connIndex=2 location=LAX
INF Registered tunnel connection connIndex=3 location=LAX
```

看到 4 条 "Registered" 就说明 tunnel 已经活了。

---

## 第 8 步：从外部验收

**从你 Mac 或手机**（不是 NAS）跑：

```bash
curl -s https://chrono-synth-beta.wontlost.com/healthz
# 期望：{"status":"ok",...}

curl -s https://chrono-synth-beta.wontlost.com/readyz
# 期望：{"status":"ok","database":"ok",...}

curl -sI https://chrono-synth-beta.wontlost.com/ | head -5
# 期望：HTTP/2 200
# 期望：cf-ray: ...（证明走了 CF）
# 期望：content-type: text/html...（web nginx 返回 SPA）
```

浏览器打开 `https://chrono-synth-beta.wontlost.com/`，应看到 chrono-synth 登录页。

---

## 故障排查

### `cloudflared` 日志报 "Authorization failed"

→ Token 错。回 CF dashboard → 你的 tunnel → "Install connector" tab 重新复制完整 token，注意不要漏字符。重跑：

```bash
bash setup-nas-beta.sh --force /volume2/docker/chrono-beta chrono-synth-beta.wontlost.com '<new-token>'
sudo docker compose up -d
```

### `cloudflared` 日志只看到 1-2 条 Registered（不是 4 条）

CF 默认开 4 条 HA 连接。如果只看到 1-2 条：

- 检查 NAS 出站到 `*.cloudflare.com:443` 是否被防火墙挡了
- 检查 NAS 的 NTP 时间是否准（cloudflared 对时间偏差敏感）
- 看 `sudo docker compose logs cloudflared --tail 200` 是否有 "connection failed" 错误

### `curl https://chrono-synth-beta.wontlost.com/healthz` 报 530 / 1033

→ Tunnel 已建但 cloudflared 到 `web:8080` 没通。检查：

```bash
sudo docker compose exec cloudflared wget -qO- http://web:8080/frontend-healthz
# 期望：ok
```

如果不通，是 docker network 问题；看 `sudo docker network ls` 是否有 `chrono-beta_default`，所有 4 个 service 是否都 attach 到同一网。

### 浏览器报 "CF redirected too many times"

CF SSL/TLS mode 设成了 **Flexible**（CF 用 HTTPS 但回 origin 用 HTTP，造成循环重定向）。改成 **Full** 或 **Full (Strict)**。

### 浏览器登录后 token 验证失败 401

`CHRONO_JWT_ISSUER` 必须等于 `https://chrono-synth-beta.wontlost.com`（含 scheme）。脚本生成的 .env 已经对，但如果你手改过域名，需要：

```bash
# 改 .env 里的 BETA_DOMAIN，然后
sudo docker compose up -d --force-recreate backend
```

---

## GA 切到裸域 `chrono-synth.wontlost.com`

beta 完成后：

1. CF dashboard → tunnel → Public Hostname → 改 Subdomain `chrono-synth-beta` → `chrono-synth`
2. NAS 上 `.env` 里 `BETA_DOMAIN=chrono-synth.wontlost.com`
3. `sudo docker compose up -d --force-recreate backend web`
4. 旧 `chrono-synth-beta.wontlost.com` 在 CF 里删掉，避免双入口
5. 通知用户更新 OAuth 回调 URI / SSO callback URL

---

## 安全 checklist

- [ ] CF_TUNNEL_TOKEN 没 commit 到任何 git 仓库
- [ ] `.env` 文件 `chmod 600`（脚本已自动做）
- [ ] CF dashboard 开了 WAF Managed Rules
- [ ] `/api/*` 路径在 CF 上 Bypass cache（防止跨用户 token 泄露）
- [ ] CF SSL/TLS mode 是 **Full**（不是 Flexible）
- [ ] NAS 路由器 80/443 入站 NAT 已**关闭**（CF Tunnel 模式下不需要）
- [ ] 内测结束后，禁用 / 删除这个 tunnel（不要让 token 永远活着）
