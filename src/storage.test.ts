/**
 * Storage unit tests: getString round-trips identifiers losslessly (FSR-17) and
 * CookieStorage.get handles duplicate cookie names (FSR-56).
 */

import { storage, cookies } from './storage';

describe('SafeStorage.getString (FSR-17)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* memory */ } });

  test('a numeric-looking user_id round-trips as the exact STRING (get would parse to number)', () => {
    storage.set('dl_user_id', '12345');
    expect(storage.get('dl_user_id')).toBe(12345);        // the bug: JSON.parse → number
    expect(storage.getString('dl_user_id')).toBe('12345'); // the fix: exact string
    expect(typeof storage.getString('dl_user_id')).toBe('string');
  });

  test('a 16+-digit snowflake id is NOT precision-corrupted by getString', () => {
    const id = '1234567890123456789';
    storage.set('dl_user_id', id);
    // get() would JSON.parse → 1234567890123456800 (precision loss)
    expect(String(storage.get('dl_user_id'))).not.toBe(id);
    // getString returns the exact bytes
    expect(storage.getString('dl_user_id')).toBe(id);
  });

  test("the literal string 'null' does not de-identify via getString", () => {
    storage.set('dl_user_id', 'null');
    expect(storage.get('dl_user_id')).toBeNull();        // JSON.parse('null') → null
    expect(storage.getString('dl_user_id')).toBe('null'); // preserved
  });

  test('returns the default when the key is absent', () => {
    expect(storage.getString('dl_user_id', null)).toBeNull();
  });
});

describe('CookieStorage.get with duplicate names (FSR-56)', () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeAll(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
      || Object.getOwnPropertyDescriptor(document, 'cookie');
  });

  const mockCookie = (value: string) => {
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => value });
  };

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(document, 'cookie', originalDescriptor);
    }
  });

  test('returns the first value when the same cookie name appears more than once', () => {
    // Simulate a host-only + domain-wide duplicate (jsdom keeps them as one string).
    mockCookie('_fbp=fb.1.first; x=1; _fbp=fb.1.second');
    // Old impl split on '; _fbp=' → 3 parts → returned null. Now returns the first.
    expect(cookies.get('_fbp')).toBe('fb.1.first');
  });

  test('returns null when the cookie is genuinely absent', () => {
    mockCookie('x=1; y=2');
    expect(cookies.get('_fbp')).toBeNull();
  });

  test('reads a single normally-set cookie', () => {
    mockCookie('__dl_visitor_id=anon_abc; other=1');
    expect(cookies.get('__dl_visitor_id')).toBe('anon_abc');
  });
});
