import { describe, expect, it, vi, afterEach } from 'vitest';
import { safeExternalUrl, navigateExternal } from './external-url';

/* 审计 Warning B6-3：Billing checkout/portal、OAuth 授权、导出下载四处都把
 * 服务端返回的字符串直接赋给 window.location / href。上游被攻陷或响应被篡改时，
 * 用户会被带到 javascript: 伪协议（同源脚本执行）或钓鱼站点。 */

describe('safeExternalUrl — 伪协议阻断', () => {
  it.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',            /* 协议大小写不敏感 */
    'java\tscript:alert(1)',          /* 制表符混淆 */
    'data:text/html,<script>alert(1)</script>',
    'blob:https://evil.test/xyz',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('拒绝 %s', (raw) => {
    expect(safeExternalUrl(raw)).toBeNull();
  });

  it('拒绝 http（防令牌走明文信道）', () => {
    expect(safeExternalUrl('http://checkout.stripe.com/pay')).toBeNull();
  });

  it('拒绝相对路径（外部跳转必须是绝对 URL）', () => {
    expect(safeExternalUrl('/agent/oauth/google')).toBeNull();
    expect(safeExternalUrl('//evil.test/phish')).toBeNull();
  });

  it.each([null, undefined, '', '   ', 'not a url'])('拒绝空值/畸形串 %s', (raw) => {
    expect(safeExternalUrl(raw as string | null | undefined)).toBeNull();
  });

  it('放行合法 https，并归一化', () => {
    expect(safeExternalUrl('https://checkout.stripe.com/c/pay/abc'))
      .toBe('https://checkout.stripe.com/c/pay/abc');
    expect(safeExternalUrl('https://accounts.google.com/o/oauth2/auth?scope=x'))
      .toBe('https://accounts.google.com/o/oauth2/auth?scope=x');
  });
});

describe('navigateExternal', () => {
  const assign = vi.fn();

  afterEach(() => {
    vi.restoreAllMocks();
    assign.mockClear();
  });

  it('合法 URL → 跳转并返回 true', () => {
    vi.stubGlobal('window', { location: { assign } });
    expect(navigateExternal('https://checkout.stripe.com/x')).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/x');
  });

  it('伪协议 → **不跳转**并返回 false（调用方据此报错）', () => {
    vi.stubGlobal('window', { location: { assign } });
    expect(navigateExternal('javascript:alert(1)')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
