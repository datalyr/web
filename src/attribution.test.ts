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

  test('9.A.6: newer click IDs resolve to their real source (not the "paid" fallback)', () => {
    for (const [param, source] of [
      ['gbraid', 'google'], ['wbraid', 'google'], ['rdt_cid', 'reddit'],
      ['obclid', 'outbrain'], ['irclid', 'impact'], ['ko_click_id', 'klaviyo'],
    ] as const) {
      setPage(`?${param}=x`);
      const a = new AttributionManager();
      expect(a.captureAttribution().source).toBe(source);
    }
  });

  test('Klaviyo profile binding is one-shot and never enters attribution or the visible URL', () => {
    setPage('?utm_source=klaviyo&utm_id=msg_123&dl_kprofile_id=profile_01HXYZ');
    const a = attr.captureAttribution() as any;

    expect(a.utm_id).toBe('msg_123');
    expect(a.dl_kprofile_id).toBeUndefined();
    expect(a.landingPage).not.toContain('profile_01HXYZ');
    expect(window.location.search).not.toContain('dl_kprofile_id');
    expect(attr.consumeKlaviyoProfileBinding()).toBe('profile_01HXYZ');
    expect(attr.consumeKlaviyoProfileBinding()).toBeNull();

    attr.captureAttribution();
    expect(attr.consumeKlaviyoProfileBinding()).toBeNull();
  });

  test('Klaviyo profile binding is discarded when marketing consent is denied', () => {
    setPage('?dl_kprofile_id=profile_blocked');
    const denied = new AttributionManager({ marketingAllowed: () => false });
    denied.captureAttribution();

    expect(window.location.search).not.toContain('dl_kprofile_id');
    expect(denied.consumeKlaviyoProfileBinding()).toBeNull();
  });

  test('Snap: ScCid is captured and normalized to the canonical sclid field', () => {
    // Snapchat appends &ScCid= (not sclid). Must land under sclid so server-side
    // attribution + the Snap CAPI sender (sc_click_id) can read it.
    setPage('?ScCid=snap_click_1');
    const a = attr.captureAttribution() as any;
    expect(a.sclid).toBe('snap_click_1');
    expect(a.clickId).toBe('snap_click_1');
    expect(a.clickIdType).toBe('sclid');
    expect(a.source).toBe('snapchat');
  });

  test('Snap: lowercase sccid alias is also captured as sclid', () => {
    setPage('?sccid=snap_click_2');
    const a = attr.captureAttribution() as any;
    expect(a.sclid).toBe('snap_click_2');
  });

  test('Impact: irclickid (the real landing param) is captured as canonical irclid', () => {
    // Impact appends &irclickid= (NOT irclid). Must land under irclid so the server /
    // MV / source map (irclid→impact) read it; bare irclid alone was dark for real clicks.
    setPage('?irclickid=impact_click_1');
    const a = attr.captureAttribution() as any;
    expect(a.irclid).toBe('impact_click_1');
    expect(a.source).toBe('impact');
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

  test('FSR-13: UTM params are emitted under the canonical utm_* keys (what ingest/MVs read) AND the stripped alias', () => {
    setPage('?utm_source=klaviyo&utm_campaign=spring&utm_medium=email&utm_id=message_01HXYZ');
    const a = attr.captureAttribution() as any;
    // canonical (ingest reads event_data.utm_source; every attribution MV keys on it)
    expect(a.utm_source).toBe('klaviyo');
    expect(a.utm_campaign).toBe('spring');
    expect(a.utm_medium).toBe('email');
    expect(a.utm_id).toBe('message_01HXYZ');
    expect(a.id).toBeUndefined();
    // stripped alias still present (dashboard MVs + determineSource/Medium read it)
    expect(a.source).toBe('klaviyo');
    expect(a.campaign).toBe('spring');
    expect(a.medium).toBe('email');
  });

  test('FSR-13: getAttributionData merges the canonical utm_* keys (so event_data carries them)', () => {
    setPage('?utm_source=podcast&utm_campaign=ep42');
    const data = attr.getAttributionData() as any;
    expect(data.utm_source).toBe('podcast');
    expect(data.utm_campaign).toBe('ep42');
  });

  test('FSR-14: a NEW fbclid over a stale _fbc regenerates _fbc with the new fbclid + a current time', () => {
    // Seed a stale _fbc from an OLD campaign (old creation time, old fbclid).
    cookies.set('_fbc', 'fb.1.1000000000000.OLD_CLICK', 90);
    setPage('?fbclid=NEW_CLICK');
    const data = attr.getAttributionData() as any;
    // _fbc must now embed the NEW fbclid, not keep the stale one.
    expect(data._fbc).toMatch(/^fb\.1\.\d+\.NEW_CLICK$/);
    const ts = Number(data._fbc.split('.')[2]);
    expect(ts).toBeGreaterThan(1000000000000); // refreshed creation time, not the stale one
  });

  test('FSR-14: the SAME fbclid already embedded in _fbc is left untouched (no churn)', () => {
    cookies.set('_fbc', 'fb.1.1700000000000.SAME_CLICK', 90);
    setPage('?fbclid=SAME_CLICK');
    const data = attr.getAttributionData() as any;
    expect(data._fbc).toBe('fb.1.1700000000000.SAME_CLICK');
  });

  test('FSR-48: an internal-nav fallback uses the fresher LAST touch, not the stale first touch', () => {
    // First touch: January gclid.
    setPage('?gclid=jan_click');
    attr.getAttributionData();
    // Later, a real Meta click becomes the last touch.
    attr.clearCache();
    setPage('?fbclid=may_click');
    attr.getAttributionData();
    // Now an internal navigation (no signal) — the fallback must carry the LAST touch
    // (facebook), not the first touch (google) and its stale clickId.
    attr.clearCache();
    setPage('', 'http://localhost/some-internal-page');
    const data = attr.getAttributionData() as any;
    expect(data.source).toBe('facebook');
    expect(data.clickId).toBe('may_click');
  });
});

describe('AttributionManager — TR-03 marketing-consent gating', () => {
  beforeEach(() => { clearAll(); setPage('', ''); });
  afterEach(() => { clearAll(); });

  test('marketing DECLINED: strips click IDs + ad cookies from the payload, keeps utm/source', () => {
    const attr = new AttributionManager({ marketingAllowed: () => false });
    setPage('?fbclid=fb_1&gclid=g_1&utm_source=facebook&utm_campaign=spring');
    const data = attr.getAttributionData() as any;
    // marketing signals stripped
    expect(data.fbclid).toBeUndefined();
    expect(data.gclid).toBeUndefined();
    expect(data.clickId).toBeUndefined();
    expect(data.clickIdType).toBeUndefined();
    expect(data._fbp).toBeUndefined();
    expect(data._fbc).toBeUndefined();
    // analytics signals survive
    expect(data.utm_source).toBe('facebook');
    expect(data.utm_campaign).toBe('spring');
    expect(data.source).toBe('facebook');
  });

  test('marketing DECLINED: does NOT synthesize/write _fbp or _fbc cookies', () => {
    const attr = new AttributionManager({ marketingAllowed: () => false });
    setPage('?fbclid=xyz');
    attr.getAttributionData();
    expect(cookies.get('_fbp')).toBeNull();
    expect(cookies.get('_fbc')).toBeNull();
    expect(cookies.get('_dl_fbclid_at')).toBeNull();
  });

  test('marketing ALLOWED (control): synthesizes _fbp/_fbc and ships click IDs, unchanged', () => {
    const attr = new AttributionManager({ marketingAllowed: () => true });
    setPage('?fbclid=abc');
    const data = attr.getAttributionData() as any;
    expect(data.fbclid).toBe('abc');
    expect(data._fbp).toMatch(/^fb\.1\.\d+\.\d+$/);
    expect(data._fbc).toMatch(/^fb\.1\.\d+\.abc$/);
    expect(cookies.get('_fbc')).toMatch(/^fb\.1\.\d+\.abc$/);
  });

  test('live re-grant: the predicate is re-evaluated per event (declined → then granted)', () => {
    let allowed = false;
    const attr = new AttributionManager({ marketingAllowed: () => allowed });
    setPage('?fbclid=lll');
    expect((attr.getAttributionData() as any).fbclid).toBeUndefined(); // declined
    allowed = true; // consent granted mid-session
    attr.clearCache();
    setPage('?fbclid=lll');
    expect((attr.getAttributionData() as any).fbclid).toBe('lll'); // restored
  });
});
