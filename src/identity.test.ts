/**
 * IdentityManager tests: the _dl_vid cross-domain bridge must not be an identity-takeover
 * footgun (FSR-50), and a freshly generated id is gated on consent at init (FSR-107).
 */

import { IdentityManager } from './identity';
import { storage, cookies } from './storage';

function setUrl(search: string): void {
  window.history.replaceState({}, '', '/' + (search || ''));
}

function clearAll(): void {
  try { localStorage.clear(); } catch { /* memory fallback */ }
  cookies.remove('__dl_visitor_id');
}

describe('IdentityManager — _dl_vid adoption (FSR-50)', () => {
  beforeEach(() => { clearAll(); setUrl(''); });
  afterEach(() => { clearAll(); setUrl(''); });

  test('a valid anon_<uuid> _dl_vid is adopted for a FRESH visitor and stripped from the URL', () => {
    const vid = 'anon_12345678-1234-4234-8234-123456789012';
    setUrl('?_dl_vid=' + vid + '&keep=1');
    const id = new IdentityManager();
    expect(id.getAnonymousId()).toBe(vid);
    expect(window.location.search).not.toContain('_dl_vid'); // stripped so it can't be re-shared
    expect(window.location.search).toContain('keep=1');       // other params preserved
  });

  test('a malformed / oversized _dl_vid is rejected (no takeover via arbitrary value)', () => {
    setUrl('?_dl_vid=' + encodeURIComponent('anon_' + 'A'.repeat(5000)));
    const id = new IdentityManager();
    expect(id.getAnonymousId()).not.toContain('AAAA');
    expect(id.getAnonymousId()).toMatch(/^anon_[0-9a-f-]+$/i);
  });

  test('an EXISTING visitor id is NOT overwritten by a _dl_vid in the URL', () => {
    const existing = 'anon_existing1-1111-4111-8111-111111111111';
    cookies.set('__dl_visitor_id', existing, 365);
    setUrl('?_dl_vid=anon_22222222-2222-4222-8222-222222222222');
    const id = new IdentityManager();
    expect(id.getAnonymousId()).toBe(existing);
  });
});

describe('IdentityManager — consent-gated persistence (FSR-107)', () => {
  beforeEach(() => { clearAll(); setUrl(''); });
  afterEach(() => { clearAll(); setUrl(''); });

  test('persistNewId:false keeps a generated id in memory only (no cookie / localStorage write)', () => {
    const id = new IdentityManager({ persistNewId: false });
    expect(id.getAnonymousId()).toMatch(/^anon_/);
    expect(storage.getString('dl_anonymous_id')).toBeNull();
    expect(cookies.get('__dl_visitor_id')).toBeNull();
  });

  test('persistNewId default (true) persists a generated id', () => {
    const id = new IdentityManager();
    expect(storage.getString('dl_anonymous_id')).toBe(id.getAnonymousId());
  });

  test('TR-15: enablePersistence() flushes a memory-only id to cookie + localStorage on grant', () => {
    const id = new IdentityManager({ persistNewId: false });
    const anon = id.getAnonymousId();
    expect(storage.getString('dl_anonymous_id')).toBeNull(); // declined at init → memory only
    id.enablePersistence(); // consent granted mid-session
    expect(storage.getString('dl_anonymous_id')).toBe(anon); // same id, now persisted
    expect(cookies.get('__dl_visitor_id')).toBe(anon);
  });

  test('TR-15: enablePersistence() is a no-op when already persisting (does not rotate the id)', () => {
    const id = new IdentityManager(); // persistNewId default true
    const anon = id.getAnonymousId();
    id.enablePersistence();
    expect(storage.getString('dl_anonymous_id')).toBe(anon);
    expect(id.getAnonymousId()).toBe(anon);
  });
});
