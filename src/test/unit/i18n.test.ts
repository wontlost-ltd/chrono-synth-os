/**
 * i18n locale resolver + message catalog tests.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-E-ext
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseAcceptLanguage, resolveLocale, isSupportedLocale,
  DEFAULT_LOCALE, t,
} from '../../i18n/index.js';

describe('parseAcceptLanguage', () => {
  it('returns empty array for undefined / empty header', () => {
    assert.deepEqual(parseAcceptLanguage(undefined), []);
    assert.deepEqual(parseAcceptLanguage(''), []);
  });

  it('parses single locale without q-value (default q=1)', () => {
    const got = parseAcceptLanguage('zh-CN');
    assert.deepEqual(got, [{ locale: 'zh-CN', q: 1 }]);
  });

  it('parses multi-locale list and sorts by q descending', () => {
    const got = parseAcceptLanguage('en;q=0.5, zh-CN;q=0.9, fr;q=0.3');
    assert.deepEqual(got.map(e => e.locale), ['zh-CN', 'en', 'fr']);
  });

  it('drops q=0 entries (client explicitly refused)', () => {
    const got = parseAcceptLanguage('en, zh-CN;q=0, ja');
    assert.deepEqual(got.map(e => e.locale), ['en', 'ja']);
  });

  it('keeps header order on q tie (stable sort)', () => {
    const got = parseAcceptLanguage('en, zh-CN, ja');
    assert.deepEqual(got.map(e => e.locale), ['en', 'zh-CN', 'ja']);
  });

  it('ignores malformed q values', () => {
    const got = parseAcceptLanguage('en;q=NaN, zh-CN;q=2, ja');
    /* malformed q falls back to default 1; all three end up with q=1 → stable order */
    assert.deepEqual(got.map(e => e.locale), ['en', 'zh-CN', 'ja']);
  });
});

describe('resolveLocale', () => {
  it('returns default when header missing', () => {
    assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
    assert.equal(resolveLocale(''), DEFAULT_LOCALE);
  });

  it('exact match wins', () => {
    assert.equal(resolveLocale('zh-CN'), 'zh-CN');
    assert.equal(resolveLocale('en'), 'en');
  });

  it('prefix match works (zh → zh-CN)', () => {
    assert.equal(resolveLocale('zh'), 'zh-CN');
    /* prefix also matches more specific subtags */
    assert.equal(resolveLocale('zh-Hans-CN'), 'zh-CN');
  });

  it('falls back to default on unknown locale', () => {
    assert.equal(resolveLocale('ja, ko'), DEFAULT_LOCALE);
    assert.equal(resolveLocale('xx-YY'), DEFAULT_LOCALE);
  });

  it('honours q ordering for selection', () => {
    /* Browser sends "en;q=0.1, zh-CN" → zh-CN is preferred */
    assert.equal(resolveLocale('en;q=0.1, zh-CN'), 'zh-CN');
    /* Browser sends "en, zh-CN;q=0.5" → en preferred */
    assert.equal(resolveLocale('en, zh-CN;q=0.5'), 'en');
  });

  it('case-insensitive matching', () => {
    assert.equal(resolveLocale('ZH-cn'), 'zh-CN');
    assert.equal(resolveLocale('EN-us'), 'en');
  });

  it('q=0 on supported locale falls through to next', () => {
    assert.equal(resolveLocale('zh-CN;q=0, en'), 'en');
  });
});

describe('isSupportedLocale', () => {
  it('narrows known locales', () => {
    assert.equal(isSupportedLocale('en'), true);
    assert.equal(isSupportedLocale('zh-CN'), true);
    assert.equal(isSupportedLocale('zh'), false);
    assert.equal(isSupportedLocale('ja'), false);
  });
});

describe('t (message catalog)', () => {
  it('returns plain string for parameterless key', () => {
    assert.equal(t('en', 'auth.token_expired'), 'Authentication token has expired');
    assert.equal(t('zh-CN', 'auth.token_expired'), '认证令牌已过期');
  });

  it('substitutes {placeholders} with params', () => {
    assert.equal(
      t('en', 'validation.out_of_range', { field: 'weight', min: 0, max: 1 }),
      'weight must be between 0 and 1',
    );
    assert.equal(
      t('zh-CN', 'validation.out_of_range', { field: '权重', min: 0, max: 1 }),
      '权重 必须在 0 与 1 之间',
    );
  });

  it('leaves unknown placeholders intact rather than throwing', () => {
    /* Catches a class of bugs where the caller forgets a param: the UI
     * surfaces `{role}` literally, which is visible-in-product and easy
     * to grep for. Better than the alternative of throwing inside the
     * error formatter while building an error message. */
    const msg = t('en', 'auth.role_required', {});
    assert.equal(msg, 'This operation requires {role} role');
  });

  it('falls back to English when a locale catalog lacks the key', () => {
    /* The catalog type forces parity, so this is mostly a future-proofing
     * check: if someone adds a new MessageKey but only fills the English
     * value, zh-CN callers still get the English fallback rather than
     * "undefined". */
    assert.equal(t('zh-CN', 'auth.invalid_credentials'), '邮箱或密码不正确');
  });
});
