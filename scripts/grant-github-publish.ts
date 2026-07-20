#!/usr/bin/env node
/**
 * 一次性脚本（验收用）：授权 companion persona 使用 github 写工具（github.comment / github.review）。
 *
 * publish 端点经 ToolInvocationPipeline，pipeline 授权门要求：① persona 有 active AgencyAuthorization
 * ② (persona, tool) 有未撤销 ToolPermission。二者缺一 → denied_authorization/denied_permission。
 * 这是**人工授权层**（对外写工具默认不自动授权——发布是不可逆副作用）。本脚本模拟人工授权这一步。
 *
 * 与 server / connect-github 用**同一** CHRONO_DB_PATH 文件库运行（凭据 + 授权落同一 default 租户）。
 *
 * 用法：
 *   CHRONO_DB_DRIVER=sqlite CHRONO_DB_PATH=/abs/chrono.db \
 *   CHRONO_ENCRYPTION_ENABLED=true CHRONO_ENCRYPTION_MASTER_KEY=<32B base64> \
 *   node dist/scripts/grant-github-publish.js
 */

import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/storage/index.js';
import { AgencyAuthorizationService } from '../src/agent/agency-authorization-service.js';
import { ToolPermissionService } from '../src/agent/tool-permission-service.js';

const PERSONA = 'default';
const TENANT = process.env.CHRONO_SEED_TENANT_ID?.trim() || 'default';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config);
  try {
    /* ① AgencyAuthorization：persona 获授权可用这两个写工具（scope=communication）。 */
    new AgencyAuthorizationService(db).create({
      tenantId: TENANT,
      personaId: PERSONA,
      principalUserId: 'user_1',
      scope: 'communication',
      scopeDescription: '验收：授权 companion 发布 GitHub 回复（issue 评论 / PR review）',
      allowedTools: ['github.comment', 'github.review'],
    });
    /* ② ToolPermission：(persona, tool) 执行权限。 */
    const perms = new ToolPermissionService(db);
    perms.grant({ tenantId: TENANT, personaId: PERSONA, toolId: 'github.comment', scope: 'execute', constraints: {}, grantedBy: 'user_1' });
    perms.grant({ tenantId: TENANT, personaId: PERSONA, toolId: 'github.review', scope: 'execute', constraints: {}, grantedBy: 'user_1' });

    console.log(`✓ 已授权 persona=${PERSONA}（tenant=${TENANT}）使用 github.comment / github.review 写工具`);
    console.log('  AgencyAuthorization(communication) + ToolPermission(execute) 各就位');
    console.log('  publish 端点现在过授权门；仍受不可降级人工审批门（confirmation token）约束');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('✗ 授权失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
