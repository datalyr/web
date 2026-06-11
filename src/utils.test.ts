/**
 * Unit tests for utils: the eTLD+1 helper (FSR-47) and sanitizeEventData (FSR-57).
 */

import { getRegistrableDomain, sanitizeEventData } from './utils';

describe('getRegistrableDomain (FSR-47)', () => {
  test('plain .com host → eTLD+1', () => {
    expect(getRegistrableDomain('www.example.com')).toBe('example.com');
    expect(getRegistrableDomain('example.com')).toBe('example.com');
    expect(getRegistrableDomain('a.b.example.com')).toBe('example.com');
  });

  test('two-part ccTLDs keep three labels (the bug FSR-47 fixes)', () => {
    expect(getRegistrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(getRegistrableDomain('www.google.co.uk')).toBe('google.co.uk');
    expect(getRegistrableDomain('store.example.com.au')).toBe('example.com.au');
    // The whole point: a merchant on *.example.co.uk and an external google.co.uk
    // referrer must NOT collapse to the same root ('co.uk').
    expect(getRegistrableDomain('shop.example.co.uk'))
      .not.toBe(getRegistrableDomain('www.google.co.uk'));
  });

  test('localhost and IPs are returned unchanged', () => {
    expect(getRegistrableDomain('localhost')).toBe('localhost');
    expect(getRegistrableDomain('192.168.1.10')).toBe('192.168.1.10');
  });
});

describe('sanitizeEventData (FSR-57)', () => {
  test('keeps innocent keys that merely CONTAIN a sensitive substring', () => {
    const out = sanitizeEventData({
      author: 'jane',
      authority: 'admin',
      passenger_count: 3,
      passport_number: 'X1',
      session_type: 'trial',
      cookie_consent: true,
    });
    expect(out.author).toBe('jane');
    expect(out.authority).toBe('admin');
    expect(out.passenger_count).toBe(3);
    expect(out.passport_number).toBe('X1');
    expect(out.session_type).toBe('trial');
    expect(out.cookie_consent).toBe(true);
  });

  test('still drops real credential keys (whole-token / camelCase match)', () => {
    const out = sanitizeEventData({
      password: 'hunter2',
      auth_token: 'abc',
      authToken: 'abc',
      api_key: 'k',
      client_secret: 's',
    });
    expect('password' in out).toBe(false);
    expect('auth_token' in out).toBe(false);
    expect('authToken' in out).toBe(false);
    expect('api_key' in out).toBe(false);
    expect('client_secret' in out).toBe(false);
  });

  test('does NOT redact 3-label hostnames, semver, 32-hex IDs, or md5-style values', () => {
    const out = sanitizeEventData({
      referrer_host: 'www.google.com',
      version: '1.7.3',
      order_id: 'a'.repeat(32),                 // 32-hex order id
      user_id: 'deadbeefdeadbeefdeadbeefdeadbeef', // 32-hex user id ($alias contract)
    });
    expect(out.referrer_host).toBe('www.google.com');
    expect(out.version).toBe('1.7.3');
    expect(out.order_id).toBe('a'.repeat(32));
    expect(out.user_id).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
  });

  test('still redacts an unambiguous JWT value', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123sig';
    const out = sanitizeEventData({ id_proof: jwt });
    expect(out.id_proof).toBe('[Redacted]');
  });
});
