#!/usr/bin/env node
// 灌 demo 数据到 NAS beta（chrono-synth-beta.wontlost.com）
// 用法：
//   ADMIN_EMAIL=admin@beta.test ADMIN_PW=*** node scripts/seed-nas-demo.mjs
// 或：
//   node scripts/seed-nas-demo.mjs admin@beta.test ***
//
// 产出：
//   - 5 个 personas（agent-summarizer / classifier / router / fetcher / writer）
//   - 8 个 tools × 5 personas = 40 个 tool-permissions
//   - 1 个 denied agency-authorization（router send_email → external）
//
// 幂等：重跑会跳过已存在的 displayName persona。

const BASE = process.env.BASE ?? 'https://chrono-synth-beta.wontlost.com';
const EMAIL = process.env.ADMIN_EMAIL ?? process.argv[2];
const PW = process.env.ADMIN_PW ?? process.argv[3];

if (!EMAIL || !PW) {
  console.error('Usage: ADMIN_EMAIL=... ADMIN_PW=... node seed-nas-demo.mjs');
  process.exit(1);
}

async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { token: j.data.accessToken, userId: j.data.userId };
}

async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) {
    throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

const PERSONAS = [
  { name: 'agent-summarizer', purpose: 'Summarize long documents into action items' },
  { name: 'agent-classifier', purpose: 'Classify customer support tickets by urgency' },
  { name: 'agent-router',     purpose: 'Route tasks across worker agents based on capability' },
  { name: 'agent-fetcher',    purpose: 'Fetch external data from approved APIs' },
  { name: 'agent-writer',     purpose: 'Draft customer-facing communication' },
];

const TOOLS = [
  { id: 'web_search',      scope: 'read'    },
  { id: 'calculator',      scope: 'read'    },
  { id: 'code_interpreter',scope: 'execute' },
  { id: 'send_email',      scope: 'execute' },
  { id: 'read_file',       scope: 'read'    },
  { id: 'write_file',      scope: 'write'   },
  { id: 'db_query',        scope: 'read'    },
  { id: 'slack_message',   scope: 'execute' },
];

async function main() {
  console.log(`[seed] login ${EMAIL} → ${BASE}`);
  const { token, userId } = await login();
  console.log(`[seed] token acquired (user=${userId})`);

  /* personas */
  const existing = await api(token, 'GET', '/api/v1/admin/personas?limit=100');
  const existingPersonas = existing.data ?? [];
  const byName = new Map(existingPersonas.map(p => [p.displayName, p.personaId]));
  console.log(`[seed] existing personas: ${byName.size}`);

  const personaIds = {};
  for (const p of PERSONAS) {
    if (byName.has(p.name)) {
      personaIds[p.name] = byName.get(p.name);
      console.log(`[seed] persona "${p.name}" reused: ${personaIds[p.name]}`);
      continue;
    }
    const created = await api(token, 'POST', '/api/v1/personas', {
      displayName: p.name,
      visibility: 'private',
      profile: { purpose: p.purpose, agent: true, environment: 'demo' },
      initialKnowledge: [
        { title: 'Purpose', content: p.purpose, tags: ['demo', 'baseline'] },
      ],
    });
    personaIds[p.name] = created.data.personaId ?? created.data.id;
    console.log(`[seed] persona "${p.name}" created: ${personaIds[p.name]}`);
  }

  /* tool-permissions: 给每个 persona 都开 8 个工具 */
  console.log('[seed] granting tool-permissions…');
  let grantCount = 0;
  for (const [name, personaId] of Object.entries(personaIds)) {
    for (const t of TOOLS) {
      try {
        await api(token, 'POST', '/api/v1/admin/tool-permissions', {
          personaId,
          toolId: t.id,
          scope: t.scope,
          constraints: {
            maxActionsPerDay: 200,
            budgetLimitCents: 1000,
            requireConfirmation: t.id === 'send_email',
          },
        });
        grantCount++;
      } catch (e) {
        const msg = String(e.message);
        if (msg.includes('已存在') || msg.includes('exists') || msg.includes('conflict') || msg.includes('UNIQUE')) {
          continue;
        }
        console.warn(`  ⚠ ${name}/${t.id}: ${msg.slice(0, 120)}`);
      }
    }
  }
  console.log(`[seed] tool-permissions granted: +${grantCount}`);

  /* 一个 denied scenario：用 agency-authorization 表达 router 不能 send_email */
  if (userId && personaIds['agent-router']) {
    try {
      await api(token, 'POST', '/api/v1/admin/agency-authorizations', {
        personaId: personaIds['agent-router'],
        principalUserId: userId,
        scope: 'communication',
        scopeDescription: 'agent-router may send Slack but NOT external email — denies are logged for SOC 2 review.',
        allowedTools: ['slack_message', 'web_search', 'calculator'],
        deniedTools: ['send_email'],
      });
      console.log('[seed] agency-authorization created (router · denied send_email)');
    } catch (e) {
      const msg = String(e.message);
      if (!msg.includes('exists') && !msg.includes('UNIQUE')) {
        console.warn(`[seed] agency-authorization skipped: ${msg.slice(0, 140)}`);
      }
    }
  }

  /* 最终统计 */
  const finalPersonas = await api(token, 'GET', '/api/v1/admin/personas?limit=100');
  const finalPerms = await api(token, 'GET', '/api/v1/admin/tool-permissions');
  console.log(`\n[seed] ✓ done`);
  console.log(`       personas:         ${finalPersonas.data?.length ?? 0}`);
  console.log(`       tool-permissions: ${finalPerms.data?.length ?? 0}`);
  console.log(`\n       Verify in UI:`);
  console.log(`         ${BASE}/admin/tool-permissions`);
  console.log(`         ${BASE}/admin/tool-invocations`);
  console.log(`         ${BASE}/admin/safety/drift`);
}

main().catch(e => {
  console.error('[seed] FATAL:', e.message);
  process.exit(1);
});
