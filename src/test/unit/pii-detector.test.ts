/**
 * P1-Q-1 — PII detector + classification tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectPii, classifyText, classificationEvidence } from '../../data-classification/pii-detector.js';

describe('detectPii', () => {
  it('returns empty report for null / empty input', () => {
    assert.equal(detectPii(null).detections.length, 0);
    assert.equal(detectPii('').detections.length, 0);
    assert.equal(detectPii(undefined).detections.length, 0);
  });

  it('finds email + offsets', () => {
    const r = detectPii('contact alice@example.com please');
    assert.equal(r.detections.length, 1);
    assert.equal(r.detections[0].category, 'email');
    assert.equal(r.detections[0].matched, 'alice@example.com');
    assert.equal(r.detections[0].start, 8);
    assert.equal(r.detections[0].end, 25);
  });

  it('finds multiple categories in one string', () => {
    const r = detectPii('user alice@x.com phone 13912345678 ip 10.0.0.1');
    assert.ok(r.categories.has('email'));
    assert.ok(r.categories.has('phone'));
    assert.ok(r.categories.has('ipv4'));
    assert.equal(r.detections.length, 3);
  });

  it('detections sorted by start offset', () => {
    const r = detectPii('ip 10.0.0.1 then email alice@x.com');
    /* IP comes before email in the string regardless of pattern order. */
    assert.equal(r.detections[0].category, 'ipv4');
    assert.equal(r.detections[1].category, 'email');
  });

  it('finds Chinese ID card', () => {
    /* Valid 18-digit ID: prefix 110105 (Beijing Chaoyang) + 19900101 +
     * 4-digit suffix. */
    const r = detectPii('身份证 110105199001011234');
    assert.equal(r.detections.length, 1);
    assert.equal(r.detections[0].category, 'id_card');
  });

  it('finds card_no with major brand prefixes', () => {
    const r = detectPii('VISA 4111111111111111');
    assert.equal(r.detections[0].category, 'card_no');
  });

  it('finds JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
      + '.eyJzdWIiOiJhYmMxMjMiLCJpYXQiOjE2MDAwMDAwMDB9'
      + '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = detectPii(`token=${jwt}`);
    assert.equal(r.detections[0].category, 'jwt');
  });

  it('finds vendor API keys (sk- / ghp_ / AKIA)', () => {
    assert.equal(detectPii('key=sk-1234567890abcdef1234567890').detections[0].category, 'api_key');
    assert.equal(detectPii('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').detections[0].category, 'api_key');
    assert.equal(detectPii('AKIA-IOSFODNN7EXAMPLEKEY1').detections[0].category, 'api_key');
  });

  it('finds US SSN', () => {
    const r = detectPii('SSN 123-45-6789 on file');
    assert.equal(r.detections[0].category, 'ssn');
  });

  it('rejects SSN with reserved prefixes (000 / 666 / 9xx)', () => {
    assert.equal(detectPii('000-12-3456').detections.length, 0);
    assert.equal(detectPii('666-12-3456').detections.length, 0);
    assert.equal(detectPii('900-12-3456').detections.length, 0);
  });

  it('counts repeated matches', () => {
    const r = detectPii('alice@x.com and bob@y.com and carol@z.com');
    assert.equal(r.counts.get('email'), 3);
  });

  it('repeated invocation does not skip matches (regex.lastIndex reset)', () => {
    /* This is the load-bearing global-regex bug: forgetting to reset
     * `lastIndex` between scans makes the second call skip everything
     * up to the previous match's end position. */
    const first = detectPii('alice@x.com');
    const second = detectPii('alice@x.com');
    assert.equal(first.detections.length, 1);
    assert.equal(second.detections.length, 1);
  });
});

describe('classifyText', () => {
  it('returns sensitivity=public for clean text', () => {
    assert.deepEqual(classifyText('the quick brown fox'), { category: 'none', sensitivity: 'public' });
  });

  it('returns pii for plain email', () => {
    assert.deepEqual(classifyText('contact: alice@x.com'), { category: 'email', sensitivity: 'pii' });
  });

  it('upgrades to pci when card number present (even alongside email)', () => {
    const tag = classifyText('billing email alice@x.com card 4111111111111111');
    assert.equal(tag.sensitivity, 'pci');
    assert.equal(tag.category, 'card_no');
  });
});

describe('classificationEvidence', () => {
  it('returns counts only, NEVER raw matched text', () => {
    /* The whole point of detect-then-evidence is to avoid proliferating
     * the secret into the audit log. */
    const r = detectPii('alice@x.com 13912345678');
    const evidence = classificationEvidence(r);
    assert.equal(evidence.totalMatches, 2);
    assert.equal(evidence.byCategory['email'], 1);
    assert.equal(evidence.byCategory['phone'], 1);
    /* No matched text leaks: */
    const json = JSON.stringify(evidence);
    assert.equal(json.includes('alice@x.com'), false);
    assert.equal(json.includes('13912345678'), false);
  });
});
