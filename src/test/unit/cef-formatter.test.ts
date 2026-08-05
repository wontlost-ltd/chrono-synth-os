/**
 * P1-Q-3 — CEF formatter tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCef, wrapSyslog, auditToCef, type CefRecord, type AuditEventLike } from '../../siem/cef-formatter.js';

describe('formatCef header', () => {
  it('emits canonical header order', () => {
    const out = formatCef({ signatureId: 'sig.1', name: 'evt', severity: 5, extension: {} });
    assert.match(out, /^CEF:0\|ChronoSynth\|chrono-synth-os\|2\.0\.0\|sig\.1\|evt\|5\|/);
  });

  it('escapes pipes in header fields', () => {
    const out = formatCef({ signatureId: 'pipe|test', name: 'evt', severity: 5, extension: {} });
    assert.match(out, /pipe\\\|test/);
  });

  it('escapes backslashes in header fields', () => {
    const out = formatCef({ signatureId: 'back\\slash', name: 'evt', severity: 5, extension: {} });
    assert.match(out, /back\\\\slash/);
  });
});

describe('formatCef extension', () => {
  it('keys sorted deterministically', () => {
    const out = formatCef({
      signatureId: 's', name: 'n', severity: 1,
      extension: { z: '1', a: '2', m: '3' },
    });
    /* Trailing portion after the last pipe is the extension. */
    const ext = out.split('|').slice(7).join('|');
    assert.equal(ext, 'a=2 m=3 z=1');
  });

  it('escapes = and \\n in values', () => {
    const out = formatCef({
      signatureId: 's', name: 'n', severity: 1,
      extension: { msg: 'a=b\nc' },
    });
    assert.match(out, /msg=a\\=b\\nc/);
  });

  it('omits null / undefined values', () => {
    const out = formatCef({
      signatureId: 's', name: 'n', severity: 1,
      extension: { k1: 'v', k2: null, k3: undefined },
    });
    const ext = out.split('|').slice(7).join('|');
    assert.equal(ext, 'k1=v');
  });

  it('numeric + boolean extension values get stringified', () => {
    const out = formatCef({
      signatureId: 's', name: 'n', severity: 1,
      extension: { count: 42, flag: true },
    });
    const ext = out.split('|').slice(7).join('|');
    assert.equal(ext, 'count=42 flag=true');
  });
});

describe('wrapSyslog', () => {
  it('produces RFC 5424 frame with priority', () => {
    const wrapped = wrapSyslog('CEF:0|x|y|z|s|n|5|', {
      facility: 16, hostname: 'app-01', app: 'chrono',
    });
    /* facility 16 (local0) * 8 + severity 5 = 133 */
    assert.match(wrapped, /^<133>1 /);
    assert.match(wrapped, / app-01 chrono /);
  });

  it('clamps facility into [0,23]', () => {
    const high = wrapSyslog('CEF:0|x|y|z|s|n|5|', { facility: 99, hostname: 'h', app: 'a' });
    assert.match(high, /^<\d+>/);
    /* 23*8 + 5 = 189 */
    assert.match(high, /^<189>/);
  });
});

describe('auditToCef', () => {
  const baseEvent: AuditEventLike = {
    id: 'aud-1',
    tenantId: 'tenant-a',
    eventKind: 'business',
    actionType: 'persona.create',
    createdAt: 1_716_000_000_000,
    actorType: 'user',
    actorId: 'user-x',
    targetType: 'persona',
    targetId: 'persona-1',
    method: 'POST',
    path: '/api/v1/personas',
    statusCode: 201,
    recordHash: 'a'.repeat(64),
    chainSeq: 42,
  };

  it('uses actionType as signatureId', () => {
    const r = auditToCef(baseEvent);
    assert.equal(r.signatureId, 'persona.create');
  });

  it('severity mapping by status code: 2xx=3, 4xx=5, 5xx=8', () => {
    assert.equal(auditToCef({ ...baseEvent, statusCode: 201 }).severity, 3);
    assert.equal(auditToCef({ ...baseEvent, statusCode: 403 }).severity, 5);
    assert.equal(auditToCef({ ...baseEvent, statusCode: 500 }).severity, 8);
  });

  it('attaches tenant + chain + record_hash to extension', () => {
    const r: CefRecord = auditToCef(baseEvent);
    assert.equal(r.extension.cs1, 'tenant-a');
    assert.equal(r.extension.cs4, '42');
    assert.equal(r.extension.cfp1, 'a'.repeat(64));
    assert.equal(r.extension.externalId, 'aud-1');
    assert.equal(r.extension.rt, 1_716_000_000_000);
  });
});

/* 审计 Warning B1-10：header 字段未清换行 → syslog 记录伪造。
 * 「一事件一记录」是本模块声明的载荷不变量；能注入 CR/LF 即可凭一条真事件
 * 伪造出第二条看似合法的审计记录，正是 SIEM 最不能失守的地方。 */
describe('CEF 日志注入防护', () => {
  it('header 字段中的换行被转义，不产生第二条记录', () => {
    const out = formatCef({
      signatureId: 'sig.1\nCEF:0|Evil|fake|1.0|forged|伪造登录成功|0|',
      name: 'evt',
      severity: 5,
      extension: {},
    });
    assert.equal(out.includes('\n'), false, '输出不得含裸换行');
    assert.equal(out.includes('\r'), false, '输出不得含裸回车');
    /* 记录数由**行数**决定，而非 "CEF:" 子串出现次数——被转义后的伪造头部仍以
     * 惰性文本留在同一行内，那是无害的；真正的注入是多出一行。 */
    assert.equal(out.split(/\r\n|\r|\n/).length, 1, '只应存在一行（即一条记录）');
    /* 伪造的头部必须以转义形态存在，证明它没有被当作新记录起始：
     * 换行转成字面 \n，其自带的管道符也被转成 \| —— 两者都失去分隔语义。 */
    assert.match(out, /\\nCEF:0\\\|Evil/);
  });

  it('name 字段的 CR 同样被转义', () => {
    const out = formatCef({
      signatureId: 'sig.1', name: 'evt\rinjected', severity: 5, extension: {},
    });
    assert.equal(out.includes('\r'), false);
    assert.match(out, /evt\\ninjected/);
  });

  it('扩展值中的单独 CR 被转义（原实现只覆盖 \\n 与 \\r\\n）', () => {
    const out = formatCef({
      signatureId: 'sig.1', name: 'evt', severity: 5,
      extension: { msg: 'line1\rline2' },
    });
    assert.equal(out.includes('\r'), false);
  });

  it('控制字符被剥离', () => {
    const out = formatCef({
      signatureId: 'sig\x00.1', name: 'evt\x1b[31m', severity: 5, extension: {},
    });
    assert.equal(out.includes('\x00'), false);
    assert.equal(out.includes('\x1b'), false);
  });
});
