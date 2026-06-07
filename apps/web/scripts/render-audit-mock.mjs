#!/usr/bin/env node
// 渲染 audit-detail drawer mock 图（HTML → PNG）
// 用法：从 chrono-synth-web 目录运行

import { chromium } from 'playwright';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '/tmp/audit-detail-mock.png');

const html = `<!doctype html>
<html><head><style>
  body{margin:0;padding:48px;background:#F1F5F9;font-family:-apple-system,Inter,system-ui,sans-serif}
  .drawer{
    width:800px;background:white;border-radius:12px;padding:32px;
    box-shadow:0 20px 50px rgba(15,23,42,0.12);border:1px solid #E2E8F0;
  }
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #E2E8F0}
  h2{margin:0;font-size:22px;color:#0F172A;font-weight:600;letter-spacing:-0.3px}
  .id{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:14px;color:#64748B}
  .badge{display:inline-block;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase}
  .badge-denied{background:#FEE2E2;color:#B91C1C}
  dl{display:grid;grid-template-columns:140px 1fr;gap:16px 24px;margin:0 0 24px 0}
  dt{font-size:13px;color:#64748B;font-weight:500;text-transform:uppercase;letter-spacing:0.5px}
  dd{margin:0;font-size:14px;color:#0F172A}
  .actor-row{display:flex;align-items:center;gap:8px}
  .avatar{width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#60A5FA,#A78BFA);display:inline-flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600}
  .policy{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;background:#FEF2F2;color:#991B1B;padding:2px 8px;border-radius:4px;display:inline-block}
  .outcome{color:#991B1B;font-weight:500}
  .payload{margin-top:20px;padding-top:20px;border-top:1px solid #E2E8F0}
  .payload-label{font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
  pre{margin:0;padding:16px;background:#0F172A;color:#94A3B8;border-radius:8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;line-height:1.6;overflow:hidden}
  .k{color:#60A5FA} .s{color:#FBBF24} .v{color:#E2E8F0}
</style></head>
<body>
  <div class="drawer">
    <div class="header">
      <div>
        <h2>Invocation <span class="id">inv_7e3a8c12</span></h2>
        <div style="margin-top:6px"><span class="badge badge-denied">⚠ Denied</span></div>
      </div>
      <div style="font-size:13px;color:#64748B">2026-05-26 14:23:18 UTC</div>
    </div>
    <dl>
      <dt>Tool</dt>
      <dd><strong>send_email</strong> <span style="color:#64748B">· workspace.com.acme</span></dd>

      <dt>Actor</dt>
      <dd class="actor-row">
        <span class="avatar">AR</span>
        <span>agent-router</span>
        <span style="color:#64748B">· authorized by alice@acme-corp</span>
      </dd>

      <dt>Policy</dt>
      <dd><span class="policy">no-external-email-without-approval</span></dd>

      <dt>Outcome</dt>
      <dd class="outcome">Denied · recipient not in <code>approved-domains</code></dd>

      <dt>Audit Hash</dt>
      <dd class="id">sha256:3f8c…a91d (anchored to KMS evidence #ev_22f1)</dd>
    </dl>
    <div class="payload">
      <div class="payload-label">Tool input (redacted)</div>
      <pre><span class="k">{</span>
  <span class="k">"to"</span>: <span class="s">"external@gmail.com"</span>,
  <span class="k">"subject"</span>: <span class="s">"Q3 numbers internal"</span>,
  <span class="k">"body"</span>: <span class="s">"…[24 lines redacted]…"</span>,
  <span class="k">"requested_at"</span>: <span class="s">"2026-05-26T14:23:17.842Z"</span>
<span class="k">}</span></pre>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 900, height: 720 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: out, type: 'png', fullPage: true });
await browser.close();
console.log(`✓ ${out}`);
