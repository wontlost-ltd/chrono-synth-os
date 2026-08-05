/**
 * 单元测试：PII Redactor（P1-C 生产级脱敏）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactPii } from '../../conversation/pii-redactor.js';

describe('PII Redactor', () => {
  it('脱敏中国大陆手机号', () => {
    const r = redactPii('我的手机是 13812345678 请联系');
    assert.match(r.text, /\[REDACTED_PHONE\]/);
    assert.doesNotMatch(r.text, /13812345678/);
    assert.equal(r.categories.phone, 1);
    assert.equal(r.redactedCount, 1);
  });

  it('脱敏邮箱', () => {
    const r = redactPii('reply to alice@example.com please');
    assert.match(r.text, /\[REDACTED_EMAIL\]/);
    assert.doesNotMatch(r.text, /alice@example\.com/);
    assert.equal(r.categories.email, 1);
  });

  it('脱敏中国身份证 18 位', () => {
    const r = redactPii('身份证 110105199001011234');
    assert.match(r.text, /\[REDACTED_ID_CARD\]/);
    assert.doesNotMatch(r.text, /110105199001011234/);
    assert.equal(r.categories.id_card, 1);
  });

  it('脱敏 IPv4', () => {
    const r = redactPii('server at 192.168.1.100 down');
    assert.match(r.text, /\[REDACTED_IP\]/);
  });

  it('脱敏 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature_here_long_enough';
    const r = redactPii(`token=${jwt}`);
    assert.match(r.text, /\[REDACTED_JWT\]/);
  });

  it('脱敏 API key 启发式', () => {
    const r = redactPii('key=sk-1234567890abcdef1234567890abcdef1234567890');
    assert.match(r.text, /\[REDACTED_API_KEY\]/);
  });

  it('多类别 PII 同时出现', () => {
    const r = redactPii('user alice@x.com phone 13800000000 ip 10.0.0.1');
    assert.equal(r.categories.email, 1);
    assert.equal(r.categories.phone, 1);
    assert.equal(r.categories.ipv4, 1);
    assert.ok(r.redactedCount >= 3);
  });

  it('已脱敏占位符不被二次匹配', () => {
    const r = redactPii('[REDACTED_EMAIL] is the placeholder');
    assert.equal(r.redactedCount, 0);
  });

  it('普通文本不变', () => {
    const r = redactPii('Hello world');
    assert.equal(r.text, 'Hello world');
    assert.equal(r.redactedCount, 0);
  });
});

/* 审计 Warning B1-14：标准 AWS access key（AKIA + 16 位，共 20 字符）
 * 既不满足通用启发式的 >=32 长度，也不满足需要 [_-] 分隔符的厂商前缀模式。 */
describe('PII Redactor — AWS 访问密钥', () => {
  it('脱敏标准 AKIA 长期密钥', () => {
    const r = redactPii('key is AKIAIOSFODNN7EXAMPLE here');
    assert.match(r.text, /\[REDACTED_API_KEY\]/);
    assert.equal(r.text.includes('AKIAIOSFODNN7EXAMPLE'), false);
  });

  it('脱敏 ASIA 临时会话密钥', () => {
    const r = redactPii('temp ASIAY34FZKBOKMUTVV7A rotate');
    assert.equal(r.text.includes('ASIAY34FZKBOKMUTVV7A'), false);
  });

  it('不误伤普通大写单词', () => {
    const r = redactPii('ASIA PACIFIC REGION');
    assert.equal(r.text, 'ASIA PACIFIC REGION');
  });
});
