#!/usr/bin/env node
/**
 * 一次性脚本：把一个 GitHub App 凭据 + installation 配进运行库。
 *
 * **注意：生产环境请改用管理端点**——POST /api/v1/admin/github/app 录凭据 +
 * 在 GitHub 安装 App 后经 setup_url 回调（GET /api/v1/integrations/github/setup）
 * 自动记映射，见 src/server/routes/admin-github.ts。本脚本保留用于本地验收 /
 * 离线环境 / 批量脚本化配置。
 *
 * 与 server 用**同一个** CHRONO_DB_PATH 文件库运行，凭据落 default 租户，server 进程即可读到。
 * 私钥经 FieldEncryption(AES-256-GCM) 加密落库——须 CHRONO_ENCRYPTION_ENABLED=true + 32 字节 master key。
 *
 * 用法（env 传参，避免私钥进 argv/shell 历史）：
 *   CHRONO_DB_DRIVER=sqlite CHRONO_DB_PATH=/abs/chrono.db \
 *   CHRONO_ENCRYPTION_ENABLED=true CHRONO_ENCRYPTION_MASTER_KEY=<32B base64> \
 *   GH_APP_ID=... GH_INSTALLATION_ID=... GH_PEM_PATH=/abs/key.pem GH_REPO=owner/name \
 *   node dist/scripts/connect-github.js
 *
 * 退出码：0 成功；非 0 失败（缺参/加密未启用/私钥读失败）。
 */

import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/storage/index.js';
import { FieldEncryption } from '../src/storage/encryption.js';
import { GithubAppCredentialStore } from '../src/storage/github-app-credential-store.js';
import { realClock } from '../src/utils/clock.js';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`✗ 缺环境变量 ${name}`);
    process.exit(1);
  }
  return v.trim();
}

async function main(): Promise<void> {
  const appId = reqEnv('GH_APP_ID');
  const installationId = reqEnv('GH_INSTALLATION_ID');
  const pemPath = reqEnv('GH_PEM_PATH');
  const repo = reqEnv('GH_REPO'); // owner/name，记录进 installation.repos
  const tenantId = process.env.CHRONO_SEED_TENANT_ID?.trim() || 'default';

  const privateKeyPem = readFileSync(pemPath, 'utf8');
  if (!privateKeyPem.includes('PRIVATE KEY')) {
    console.error('✗ PEM 文件内容不含 PRIVATE KEY 头，路径可能不对');
    process.exit(1);
  }

  const config = loadConfig();
  const encryption = new FieldEncryption(config.encryption);
  if (!encryption.isEnabled) {
    console.error('✗ 加密未启用（CHRONO_ENCRYPTION_ENABLED=true + 32 字节 CHRONO_ENCRYPTION_MASTER_KEY）——拒绝明文落库私钥');
    process.exit(1);
  }

  /* createDatabase 已跑迁移（与 main.ts / seed-org.ts / server 同库同 config）。IDatabase 即
   * SyncWriteUnitOfWork（execute/queryOne/queryMany），store 只用这些——无需 ChronoSynthOS 包装，
   * 直接把 db 当 tx 传（与 store 单测同款：new GithubAppCredentialStore(db, enc, tenantId)）。 */
  const db = createDatabase(config);
  try {
    const store = new GithubAppCredentialStore(db, encryption, tenantId);
    const now = realClock.now();
    /* webhook secret 反馈段(Plan 3)才用，接+学只读用不到——存空串占位（列 NOT NULL）。 */
    store.storeApp(appId, privateKeyPem, '', null, 'connect-github-script', now);
    /* installation：github_host 公有云固定 api 主机；repos 记该 App 覆盖的 repo（本次要学的）。 */
    store.upsertInstallation(installationId, 'github.com', repo.split('/')[0] ?? null, repo, now);

    /* 回读验证（不打印私钥，只证能解密回来 + installation 反查到租户）。 */
    const readBack = store.getApp();
    const okApp = readBack?.appId === appId && readBack.privateKeyPem.includes('PRIVATE KEY');
    const resolved = store.resolveTenantByInstallation('github.com', installationId);
    console.log(`✓ 已配 GitHub App（tenant=${tenantId}）`);
    console.log(`  app_id=${appId} installation=${installationId} repo=${repo}`);
    console.log(`  回读: 私钥解密 ${okApp ? 'OK（明文未落库，密文可解密回原文）' : '✗ 失败'}`);
    console.log(`  installation 反查租户: ${resolved?.tenantId ?? '✗ 未命中'}`);
    if (!okApp || resolved?.tenantId !== tenantId) process.exit(1);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('✗ 配置失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
