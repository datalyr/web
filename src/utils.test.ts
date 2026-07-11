/**
 * Unit tests for utils: the eTLD+1 helper (FSR-47), sanitizeEventData (FSR-57)
 * and redactUrl (9.A.4).
 */

import { getRegistrableDomain, sanitizeEventData, redactUrl } from './utils';

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

describe('redactUrl (9.A.4)', () => {
  test('redacts secret/PII param VALUES but keeps the param names', () => {
    const out = redactUrl('https://shop.com/reset?token=abc123&email=jane%40x.com');
    expect(out).toBe('https://shop.com/reset?token=__redacted__&email=__redacted__');
  });

  test('click IDs and UTMs survive untouched alongside a redacted param', () => {
    const out = redactUrl(
      'https://shop.com/?fbclid=IwAR123&utm_source=facebook&utm_campaign=spring&token=s3cret'
    );
    expect(out).toContain('fbclid=IwAR123');
    expect(out).toContain('utm_source=facebook');
    expect(out).toContain('utm_campaign=spring');
    expect(out).toContain('token=__redacted__');
    expect(out).not.toContain('s3cret');
  });

  test('matching is case-insensitive on the param name', () => {
    expect(redactUrl('/cb?Code=4xyz&ACCESS_TOKEN=t')).toBe(
      '/cb?Code=__redacted__&ACCESS_TOKEN=__redacted__'
    );
  });

  test('relative URLs and bare search strings keep their shape', () => {
    expect(redactUrl('/reset?token=abc')).toBe('/reset?token=__redacted__');
    expect(redactUrl('?email=a%40b.com&plan=pro')).toBe('?email=__redacted__&plan=pro');
  });

  test('fragment survives', () => {
    expect(redactUrl('https://a.com/p?sid=1#step-2')).toBe(
      'https://a.com/p?sid=__redacted__#step-2'
    );
  });

  test('TR-04: OAuth-implicit / magic-link token in the FRAGMENT of a query-less URL is redacted', () => {
    expect(redactUrl('https://app.com/welcome#access_token=eyJhbGciOi.payLOAD.sIg')).toBe(
      'https://app.com/welcome#access_token=__redacted__'
    );
  });

  test('TR-04: multi-param implicit fragment — secrets redacted, non-secret params survive', () => {
    const out = redactUrl(
      'https://app.com/cb#access_token=eyJ.a.b&refresh_token=r-9f&expires_in=3600&token_type=bearer'
    );
    expect(out).toContain('access_token=__redacted__');
    expect(out).toContain('refresh_token=__redacted__');
    expect(out).toContain('expires_in=3600');
    expect(out).toContain('token_type=bearer');
    expect(out).not.toContain('eyJ.a.b');
    expect(out).not.toContain('r-9f');
  });

  test('TR-04: query AND fragment both carry secrets — both redacted', () => {
    expect(redactUrl('https://a.com/p?sid=1#access_token=eyJ.x.y')).toBe(
      'https://a.com/p?sid=__redacted__#access_token=__redacted__'
    );
  });

  test('TR-04: SPA hash-route with a query redacts only its query portion', () => {
    expect(redactUrl('https://a.com/app#/reset?access_token=abc&view=grid')).toBe(
      'https://a.com/app#/reset?access_token=__redacted__&view=grid'
    );
  });

  test('TR-04: a non-k=v fragment (SPA route / anchor) is left byte-identical', () => {
    expect(redactUrl('https://a.com/app#/dashboard')).toBe('https://a.com/app#/dashboard');
    expect(redactUrl('https://a.com/page#section-2')).toBe('https://a.com/page#section-2');
  });

  test('URLs without a query string (or with only clean params) are returned byte-identical', () => {
    expect(redactUrl('https://a.com/pricing')).toBe('https://a.com/pricing');
    expect(redactUrl('')).toBe('');
    // No re-encoding when nothing matched — the URL must ship exactly as observed.
    const clean = 'https://a.com/?utm_source=x&ref=abc%20def';
    expect(redactUrl(clean)).toBe(clean);
  });

  test('non-string / malformed input is returned unchanged', () => {
    expect(redactUrl(undefined as any)).toBe(undefined);
    expect(redactUrl(null as any)).toBe(null);
    expect(redactUrl('not a url ? %E0%A4%A but still fine')).toContain('not a url');
  });
});
