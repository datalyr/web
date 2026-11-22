/**
 * W14: src/fingerprint.ts had no tests. These pin what the collector reads in each
 * mode and how generateHash behaves with and without Web Crypto.
 */
import { createHash, webcrypto } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';
import { FingerprintCollector } from './fingerprint';

const restore: Array<() => void> = [];

function defineOn(target: object, key: string, value: unknown): void {
  const prior = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (prior) Object.defineProperty(target, key, prior);
    else delete (target as any)[key];
  });
}

afterEach(() => {
  while (restore.length) restore.pop()!();
});

const MINIMAL_KEYS = ['dnt', 'language', 'screen_bucket', 'timezone', 'userAgent'];

describe('FingerprintCollector.collect', () => {
  test('strict privacy mode returns only the minimal fields', () => {
    const fp = new FingerprintCollector({ privacyMode: 'strict' }).collect();
    expect(Object.keys(fp).sort()).toEqual(MINIMAL_KEYS);
  });

  test('enableFingerprinting: false returns only the minimal fields', () => {
    const fp = new FingerprintCollector({ enableFingerprinting: false }).collect();
    expect(Object.keys(fp).sort()).toEqual(MINIMAL_KEYS);
  });

  test('standard mode reads timezone, language and user agent from the browser', () => {
    const fp = new FingerprintCollector().collect();
    expect(fp.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    expect(fp.language).toBe(navigator.language || null);
    expect(fp.userAgent).toBe(navigator.userAgent || null);
  });

  test('the screen size is rounded to the nearest 100px', () => {
    defineOn(window.screen, 'width', 1366);
    defineOn(window.screen, 'height', 768);
    expect(new FingerprintCollector().collect().screen_bucket).toBe('1400x800');
    expect(new FingerprintCollector({ privacyMode: 'strict' }).collect().screen_bucket).toBe('1400x800');
  });

  test('dnt is true for Do Not Track or Global Privacy Control, otherwise null', () => {
    expect(new FingerprintCollector().collect().dnt).toBeNull();

    defineOn(window, 'globalPrivacyControl', true);
    expect(new FingerprintCollector().collect().dnt).toBe(true);
    restore.pop()!();

    defineOn(navigator, 'doNotTrack', '1');
    expect(new FingerprintCollector({ privacyMode: 'strict' }).collect().dnt).toBe(true);
  });

  test('User-Agent Client Hints are copied when the browser has them', () => {
    expect(new FingerprintCollector().collect().userAgentData).toBeUndefined();

    defineOn(navigator, 'userAgentData', {
      brands: [{ brand: 'Chromium', version: '130' }],
      mobile: true,
      platform: 'Android',
    });
    const expected = { brands: [{ brand: 'Chromium', version: '130' }], mobile: true, platform: 'Android' };
    expect(new FingerprintCollector().collect().userAgentData).toEqual(expected);
    expect(new FingerprintCollector({ privacyMode: 'strict' }).collect().userAgentData).toEqual(expected);
  });
});

describe('FingerprintCollector.generateHash', () => {
  const a = { timezone: 'Europe/Paris', language: 'fr-FR', screen_bucket: '1400x800' };
  const reordered = { screen_bucket: '1400x800', language: 'fr-FR', timezone: 'Europe/Paris' };

  test('without Web Crypto: a stable hex hash that ignores key order', async () => {
    defineOn(window, 'crypto', {});
    const collector = new FingerprintCollector();
    const h1 = await collector.generateHash(a);
    expect(h1).toMatch(/^[0-9a-f]+$/);
    expect(await collector.generateHash(reordered)).toBe(h1);
    expect(await collector.generateHash({ ...a, language: 'en-US' })).not.toBe(h1);
  });

  test('with Web Crypto: SHA-256 of the key-sorted JSON', async () => {
    defineOn(window, 'crypto', webcrypto);
    if (typeof (globalThis as any).TextEncoder === 'undefined') defineOn(globalThis, 'TextEncoder', NodeTextEncoder);
    const sortedJson = JSON.stringify({ language: 'fr-FR', screen_bucket: '1400x800', timezone: 'Europe/Paris' });
    const expected = createHash('sha256').update(sortedJson).digest('hex');
    const collector = new FingerprintCollector();
    expect(await collector.generateHash(a)).toBe(expected);
    expect(await collector.generateHash(reordered)).toBe(expected);
  });
});
