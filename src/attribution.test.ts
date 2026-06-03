/**
 * Attribution unit tests — the platform's core value, previously ZERO coverage.
 * Pins the 1.7.1 fixes: last-touch survives internal navigation (incl. same-site
 * referrer), every click ID is captured (not just the first), and the synthetic _fbp
 * is Meta-conformant.
 */

import { AttributionManager } from './attribution';
import { storage, cookies } from './storage';

// jsdom default location is http://localhost/. Drive the URL + referrer per scenario.
function setPage(search: string, referrer = ''): void {
  window.history.replaceState({}, '', '/' + (search || ''));
  Object.defineProperty(document, 'referrer', { configurable: true, value: referrer });
}

function clearAll(): void {
  try { localStorage.clear(); } catch { /* memory fallback */ }
  // Clear our cookies
  for (const k of ['_fbp', '_fbc', '_dl_fbclid_at', '_dl_gclid_at']) cookies.remove(k);
}

describe('AttributionManager — capture + last-touch (1.7.1 fixes)', () => {
  let attr: AttributionManager;

  beforeEach(() => {
    clearAll();
    setPage('', '');
    attr = new AttributionManager();
  });
  afterEach(() => { clearAll(); });

  test('captures a gclid as the primary click ID and resolves source=google/cpc', () => {
    setPage('?gclid=abc123');
    const a = attr.captureAttribution();
    expect(a.clickId).toBe('abc123');
    expect(a.clickIdType).toBe('gclid');
    expect(a.source).toBe('google');
    expect(a.medium).toBe('cpc');
  });

  test('NEW-3: a URL with BOTH fbclid and gclid captures each as a named field (primary = fbclid)', () => {
    setPage('?fbclid=fb_1&gclid=g_1');
    const a = attr.captureAttribution() as any;
    // primary is the first by CLICK_IDS priority (fbclid)
    expect(a.clickId).toBe('fb_1');
    expect(a.clickIdType).toBe('fbclid');
    // but BOTH are kept as named fields so neither platform's attribution is dropped
    expect(a.fbclid).toBe('fb_1');
    expect(a.gclid).toBe('g_1');
  });

  test('same-site referrer (internal navigation) resolves to direct, not referral', () => {
    // referrer is our own host → internal nav, must NOT count as a referral source
    setPage('', 'http://localhost/previous-page');
    const a = attr.captureAttribution();
    expect(a.source).toBe('direct');
  });

  test('external referrer still resolves a real source', () => {
    setPage('', 'https://www.google.com/search');
    const a = attr.captureAttribution();
    expect(a.source).toBe('google');
  });

  test('NEW-1: an internal navigation does NOT overwrite a real paid last-touch', () => {
    // Pageview 1: arrive via gclid → last-touch stored as google/cpc
    setPage('?gclid=paid_click');
    attr.getAttributionData();
    expect(storage.get('dl_last_touch')?.source).toBe('google');

    // Pageview 2: internal navigation (same-site referrer, no params) — must NOT
    // clobber the stored paid last-touch with direct/none.
    attr.clearCache();
    setPage('', 'http://localhost/page-1');
    attr.getAttributionData();
    expect(storage.get('dl_last_touch')?.source).toBe('google');
    expect(storage.get('dl_last_touch')?.medium).toBe('cpc');
  });

  test('a new real signal DOES update last-touch', () => {
    setPage('?gclid=first');
    attr.getAttributionData();
    expect(storage.get('dl_last_touch')?.source).toBe('google');

    // Later pageview with a Facebook click → last-touch moves to facebook
    attr.clearCache();
    setPage('?fbclid=second');
    attr.getAttributionData();
    expect(storage.get('dl_last_touch')?.source).toBe('facebook');
  });

  test('WEB-17: synthetic _fbp is Meta-conformant fb.1.<ms>.<int> (decimal, not base36)', () => {
    setPage('?fbclid=xyz');
    const data = attr.getAttributionData();
    expect(typeof data._fbp).toBe('string');
    // fb.1.<digits>.<digits> — last segment must be a decimal integer, no base36 letters
    expect(data._fbp).toMatch(/^fb\.1\.\d+\.\d+$/);
  });

  test('a direct first visit (no signal) does not store a first touch', () => {
    setPage('', '');
    attr.getAttributionData();
    // hasRealAttribution is false → no first-touch written (so the first REAL signal
    // later becomes first-touch instead of being locked to "direct")
    expect(storage.get('dl_first_touch')).toBeNull();
  });
});
