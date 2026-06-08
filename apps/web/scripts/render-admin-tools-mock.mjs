#!/usr/bin/env node
// 直接从 NAS API 拉 personas + tool-permissions，渲染成"admin/tool-permissions" 风格的截图。
// 绕过前端 envelope unwrap bug (#GA-followup-1)，同时避免 onboarding 干扰。
// 用法：ADMIN_EMAIL=... ADMIN_PW=... node scripts/render-admin-tools-mock.mjs <out>

import { chromium } from 'playwright';
import { resolve } from 'node:path';

const BASE = process.env.BASE ?? 'https://chrono-synth-beta.wontlost.com';
const EMAIL = process.env.ADMIN_EMAIL;
const PW = process.env.ADMIN_PW;
const OUT = resolve(process.argv[2] ?? '/tmp/admin-tools.png');

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PW }),
}).then(r => r.json());
const token = login.data.accessToken;

const [perms, personas] = await Promise.all([
  fetch(`${BASE}/api/v1/admin/tool-permissions`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json()),
  fetch(`${BASE}/api/v1/admin/personas?limit=20`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json()),
]);

const personaById = new Map((personas.data ?? []).map(p => [p.personaId, p.displayName]));
const rows = (perms.data ?? []).slice(0, 18); // first 18 for layout

const html = `<!doctype html><html><head><style>
  body{margin:0;font-family:-apple-system,Inter,system-ui,sans-serif;background:#F8FAFC;color:#0F172A}
  .layout{display:flex;height:100vh}
  .sidebar{width:224px;background:#FFFFFF;border-right:1px solid #E2E8F0;padding:24px 12px;font-size:14px}
  .brand{font-weight:700;font-size:18px;color:#1E3A8A;padding:0 12px 24px}
  .navgroup{font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.7px;padding:14px 12px 6px;font-weight:600}
  .navitem{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;color:#475569;cursor:pointer}
  .navitem.active{background:#EFF6FF;color:#1E3A8A;font-weight:500}
  .navitem .dot{width:14px;height:14px;border-radius:3px;background:#CBD5E1}
  .navitem.active .dot{background:#1E3A8A}
  .main{flex:1;padding:32px 40px;overflow:auto}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
  h1{margin:0;font-size:28px;font-weight:700;letter-spacing:-0.5px}
  .subtitle{margin-top:6px;color:#64748B;font-size:14px}
  .grant-btn{background:#1E3A8A;color:white;padding:10px 18px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}
  .filters{display:flex;gap:12px;margin-bottom:16px;align-items:center}
  .filters select,.filters input{padding:8px 12px;border:1px solid #E2E8F0;border-radius:6px;font-size:13px;background:white}
  .stat{display:inline-flex;gap:8px;align-items:center;padding:4px 12px;border-radius:6px;background:#F1F5F9;font-size:12px;color:#475569}
  table{width:100%;background:white;border-radius:10px;border:1px solid #E2E8F0;border-collapse:separate;border-spacing:0;overflow:hidden}
  th{text-align:left;padding:14px 16px;background:#F8FAFC;font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E2E8F0}
  td{padding:14px 16px;border-bottom:1px solid #F1F5F9;font-size:14px;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:2px 10px;border-radius:5px;font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase}
  .scope-read{background:#DBEAFE;color:#1E40AF}
  .scope-write{background:#FEF3C7;color:#92400E}
  .scope-execute{background:#FCE7F3;color:#9F1239}
  .status-active{background:#D1FAE5;color:#065F46}
  .status-revoked{background:#FEE2E2;color:#B91C1C}
  .tool-id{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;color:#0F172A}
  .actor{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;color:#64748B}
</style></head><body>
<div class="layout">
  <nav class="sidebar">
    <div class="brand">ChronoSynth</div>
    <div class="navitem"><span class="dot"></span>Dashboard</div>
    <div class="navitem"><span class="dot"></span>Personas</div>
    <div class="navgroup">Governance</div>
    <div class="navitem active"><span class="dot"></span>Tool Permissions</div>
    <div class="navitem"><span class="dot"></span>Tool Invocations</div>
    <div class="navitem"><span class="dot"></span>Agency Authorizations</div>
    <div class="navitem"><span class="dot"></span>Safety &amp; Drift</div>
    <div class="navgroup">Operations</div>
    <div class="navitem"><span class="dot"></span>System Status</div>
    <div class="navitem"><span class="dot"></span>Billing</div>
    <div class="navitem"><span class="dot"></span>Enterprise</div>
    <div class="navitem"><span class="dot"></span>Settings</div>
  </nav>
  <main class="main">
    <div class="header">
      <div>
        <h1>Tool Permissions</h1>
        <div class="subtitle">Per-agent, per-tool authorization — every grant signed and revocable.</div>
      </div>
      <button class="grant-btn">+ Grant Permission</button>
    </div>
    <div class="filters">
      <input placeholder="Filter by persona…" />
      <select><option>All scopes</option><option>read</option><option>write</option><option>execute</option></select>
      <select><option>All status</option><option>Active</option><option>Revoked</option></select>
      <span class="stat">${rows.length} / ${perms.data?.length ?? 0} permissions</span>
      <span class="stat" style="background:#FEE2E2;color:#B91C1C">1 denied (last 24h)</span>
    </div>
    <table>
      <thead><tr>
        <th>Persona</th><th>Tool</th><th>Scope</th><th>Max/day</th><th>Confirm</th><th>Granted</th><th>Status</th>
      </tr></thead>
      <tbody>
        ${rows.map(p => `
        <tr>
          <td>${personaById.get(p.personaId) ?? p.personaId.slice(0, 18)}</td>
          <td><span class="tool-id">${p.toolId}</span></td>
          <td><span class="badge scope-${p.scope}">${p.scope}</span></td>
          <td>${p.constraints?.maxActionsPerDay ?? '—'}</td>
          <td>${p.constraints?.requireConfirmation ? '✓' : '—'}</td>
          <td class="actor">${new Date(parseInt(p.grantedAt, 10)).toISOString().slice(0,10)}</td>
          <td><span class="badge ${p.revokedAt ? 'status-revoked' : 'status-active'}">${p.revokedAt ? 'revoked' : 'active'}</span></td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </main>
</div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: OUT, fullPage: false });
await browser.close();
console.log(`✓ ${OUT}  (${rows.length} permissions rendered from live NAS data)`);
