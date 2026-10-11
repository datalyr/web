/**
 * LinkedIn / X / AppLovin capture (1.9.9):
 * - AppLovin `aleid` / `alart` URL click ids (verbatim, persisted, aleid → applovin).
 * - Platform cookies under their OWN event_data keys (never folded into click-id fields):
 *   `_twclid` (parsed twclid), `_twpid`, `_axeid`, `_axwrt`, and LinkedIn's `li_fat_id`
 *   cookie as `_li_fat_id`.
 * - All of the above stripped on a marketing decline.
 * - `twclid` recovered from document.referrer when the URL has none.
 * - Exact-host referrer matching for X and LinkedIn (no more reddit.com → twitter).
 */

import { AttributionManager } from './attribution';
import { storage, cookies } from './storage';
import { getReferrerData, isHostOrSubdomain } from './utils';

function setPage(search: string, referrer = ''): void {
  window.history.replaceState({}, '', '/' + (search || ''));
  Object.defineProperty(document, 'referrer', { configurable: true, value: referrer });
}

// Raw document.cookie write so values keep the exact encoding the platform pixels use.
function setRawCookie(name: string, rawValue: string): void {
  document.cookie = `${name}=${rawValue}; path=/`;
}

const PLATFORM_COOKIES = ['_twclid', '_twpid', '_axeid', '_axwrt', 'li_fat_id'];

function clearAll(): void {
  try { localStorage.clear(); } catch { /* memory fallback */ }
  for (const k of ['_fbp', '_fbc', '_dl_fbclid_at', '_dl_gclid_at', ...PLATFORM_COOKIES]) {
    document.cookie = `${k}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    cookies.remove(k);
  }
}

// What X's pixel writes: encodeURIComponent(JSON.stringify({...})).
const X_PIXEL_TWCLID = encodeURIComponent(JSON.stringify({
  twclid: '26l6412g5p4iyj65a2oic2ayg2', pixelVersion: '2.4.11', timestamp: '1760000000000', source: 1,
}));
const AXWRT = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

describe('AppLovin aleid / alart URL click ids', () => {
  beforeEach(() => { clearAll(); setPage('', ''); });
  afterEach(() => { clearAll(); });

  test('aleid is the primary click id, resolves source=applovin/cpc, alart captured alongside', () => {
    setPage('?aleid=AbC.123-xyz_%2B%3D&alart=app_user_9');
    const a = new AttributionManager().captureAttribution() as any;
    expect(a.clickId).toBe('AbC.123-xyz_+=');
    expect(a.clickIdType).toBe('aleid');
    expect(a.aleid).toBe('AbC.123-xyz_+='); // verbatim, no format validation
    expect(a.alart).toBe('app_user_9');
    expect(a.source).toBe('applovin');
    expect(a.medium).toBe('cpc');
  });

  test('aleid / alart never outrank an existing click id on the same URL', () => {
    setPage('?alart=u1&aleid=e1&ttclid=tt1');
    const a = new AttributionManager().captureAttribution() as any;
    expect(a.clickIdType).toBe('ttclid');
    expect(a.source).toBe('tiktok');
    expect(a.aleid).toBe('e1');
    expect(a.alart).toBe('u1');
  });

  test('aleid / alart persist into first and last touch and replay on internal navigation', () => {
    const attr = new AttributionManager();
    setPage('?aleid=e_landing&alart=u_landing');
    attr.getAttributionData();
    expect(storage.get('dl_first_touch').aleid).toBe('e_landing');
    expect(storage.get('dl_first_touch').alart).toBe('u_landing');
    expect(storage.get('dl_last_touch').aleid).toBe('e_landing');

    attr.clearCache();
    setPage('', 'http://localhost/landing');
    const data = attr.getAttributionData() as any;
    expect(data.aleid).toBe('e_landing');
    expect(data.alart).toBe('u_landing');
    expect(data.clickIdType).toBe('aleid');
    expect(data.source).toBe('applovin');
  });

  test('marketing DECLINED strips aleid and alart', () => {
    setPage('?aleid=e1&alart=u1&utm_source=applovin');
    const data = new AttributionManager({ marketingAllowed: () => false }).getAttributionData() as any;
    expect(data.aleid).toBeUndefined();
    expect(data.alart).toBeUndefined();
    expect(data.clickId).toBeUndefined();
    expect(data.clickIdType).toBeUndefined();
    expect(data.utm_source).toBe('applovin');
  });
});

describe('X / AppLovin / LinkedIn cookies under their own event_data keys', () => {
  beforeEach(() => { clearAll(); setPage('', ''); });
  afterEach(() => { clearAll(); });

  test('reads every cookie on a plain pageview, without inventing a click', () => {
    setRawCookie('_twclid', X_PIXEL_TWCLID);
    setRawCookie('_twpid', 'tw.1760000000000.123456789012345678');
    setRawCookie('_axeid', 'axeid_value.1');
    setRawCookie('_axwrt', AXWRT);
    setRawCookie('li_fat_id', 'li-fat-cookie-1');

    const data = new AttributionManager().getAttributionData() as any;
    expect(data._twclid).toBe('26l6412g5p4iyj65a2oic2ayg2');
    expect(data._twpid).toBe('tw.1760000000000.123456789012345678');
    expect(data._axeid).toBe('axeid_value.1');
    expect(data._axwrt).toBe(AXWRT);
    expect(data._li_fat_id).toBe('li-fat-cookie-1');

    // Never folded into the click-id fields: this pageview is not a paid click.
    expect(data.twclid).toBeUndefined();
    expect(data.aleid).toBeUndefined();
    expect(data.li_fat_id).toBeUndefined();
    expect(data.clickId).toBeUndefined();
    expect(data.clickIdType).toBeUndefined();
    expect(data.source).toBe('direct');
    expect(storage.get('dl_last_touch')).toBeNull();
  });

  test('a URL li_fat_id and the li_fat_id cookie travel side by side, URL value wins the field', () => {
    setRawCookie('li_fat_id', 'from-cookie');
    setPage('?li_fat_id=from-url');
    const data = new AttributionManager().getAttributionData() as any;
    expect(data.li_fat_id).toBe('from-url');
    expect(data.clickIdType).toBe('li_fat_id');
    expect(data._li_fat_id).toBe('from-cookie');
  });

  test('cookies are only read, never written', () => {
    setPage('?twclid=tw1&aleid=e1&li_fat_id=l1');
    new AttributionManager().getAttributionData();
    for (const name of PLATFORM_COOKIES) expect(cookies.get(name)).toBeNull();
    expect(cookies.get('_li_fat_id')).toBeNull();
  });

  describe('_twclid parsing', () => {
    test('raw (unencoded) JSON is accepted too, as X\'s GTM template does', () => {
      setRawCookie('_twclid', '{"twclid":"raw_json_click","pixelVersion":"gtm_s2s_1_0","source":1}');
      const data = new AttributionManager().getAttributionData() as any;
      expect(data._twclid).toBe('raw_json_click');
    });

    test.each([
      ['a bare non-JSON value', 'not-json'],
      ['truncated JSON', encodeURIComponent('{"twclid":"abc"')],
      ['a JSON string, not an object', encodeURIComponent('"abc"')],
      ['an object without twclid', encodeURIComponent('{"pixelVersion":"2.4.11"}')],
      ['an empty twclid', encodeURIComponent('{"twclid":""}')],
      ['a non-string twclid', encodeURIComponent('{"twclid":12345}')],
      ['JSON null', 'null'],
      ['a malformed percent-encoding', '%7B%22twclid%22%3A%E0%A4%A'],
    ])('skips %s', (_label, raw) => {
      setRawCookie('_twclid', raw);
      setRawCookie('_twpid', 'tw.1.2');
      let data: any;
      expect(() => { data = new AttributionManager().getAttributionData(); }).not.toThrow();
      expect(data._twclid).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(data, '_twclid')).toBe(false);
      expect(data._twpid).toBe('tw.1.2'); // other cookies unaffected
    });
  });

  test('marketing DECLINED strips all five cookie keys, keeps analytics', () => {
    setRawCookie('_twclid', X_PIXEL_TWCLID);
    setRawCookie('_twpid', 'tw.1.2');
    setRawCookie('_axeid', 'ax1');
    setRawCookie('_axwrt', AXWRT);
    setRawCookie('li_fat_id', 'li1');
    setRawCookie('_ga', 'GA1.1.1.1');
    setPage('?twclid=tw_url&li_fat_id=li_url&utm_source=x');

    const data = new AttributionManager({ marketingAllowed: () => false }).getAttributionData() as any;
    for (const k of ['_twclid', '_twpid', '_axeid', '_axwrt', '_li_fat_id', 'twclid', 'li_fat_id', 'clickId', 'clickIdType']) {
      expect(data[k]).toBeUndefined();
    }
    expect(data._ga).toBe('GA1.1.1.1');
    expect(data.utm_source).toBe('x');
    document.cookie = '_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  test('a later marketing grant restores them on the next event (live predicate)', () => {
    setRawCookie('_axwrt', AXWRT);
    let allowed = false;
    const attr = new AttributionManager({ marketingAllowed: () => allowed });
    expect((attr.getAttributionData() as any)._axwrt).toBeUndefined();
    allowed = true;
    expect((attr.getAttributionData() as any)._axwrt).toBe(AXWRT);
  });
});

describe('twclid from document.referrer', () => {
  beforeEach(() => { clearAll(); setPage('', ''); });
  afterEach(() => { clearAll(); });

  test('recovered from the referrer\'s query string when the URL has none', () => {
    setPage('?utm_source=x', 'https://shop.example.com/landing?twclid=ref_click_1&utm_source=x');
    const a = new AttributionManager().captureAttribution() as any;
    expect(a.twclid).toBe('ref_click_1');
    expect(a.clickId).toBe('ref_click_1');
    expect(a.clickIdType).toBe('twclid');
    expect(a.medium).toBe('cpc');
  });

  test('source is twitter when nothing else names it', () => {
    setPage('', 'https://t.co/abc?twclid=ref_click_2');
    const a = new AttributionManager().captureAttribution() as any;
    expect(a.twclid).toBe('ref_click_2');
    expect(a.source).toBe('twitter');
  });

  test('the URL value wins over the referrer\'s', () => {
    setPage('?twclid=url_click', 'https://shop.example.com/?twclid=ref_click');
    const a = new AttributionManager().captureAttribution() as any;
    expect(a.twclid).toBe('url_click');
    expect(a.clickId).toBe('url_click');
  });

  test('a referrer twclid never outranks a click id in the URL, but is still kept', () => {
    setPage('?gclid=g1', 'https://shop.example.com/?twclid=ref_click');
    const a = new AttributionManager().captureAttribution() as any;
    expect(a.clickIdType).toBe('gclid');
    expect(a.twclid).toBe('ref_click');
  });

  test('ignored on the next internal page after the landing that carried it (already stored)', () => {
    const attr = new AttributionManager();
    setPage('?twclid=landing_click');
    attr.getAttributionData();
    const storedAt = storage.get('dl_last_touch').captured_at;

    attr.clearCache();
    setPage('', 'http://localhost/?twclid=landing_click');
    const a = attr.captureAttribution() as any;
    expect(a.twclid).toBeUndefined();
    expect(a.clickId).toBeUndefined();
    // The event still carries it through the persisted touch, which is not re-stamped.
    const data = attr.getAttributionData() as any;
    expect(data.twclid).toBe('landing_click');
    expect(storage.get('dl_last_touch').captured_at).toBe(storedAt);
  });

  test('no twclid in the referrer, an empty one, or an unparseable referrer: nothing', () => {
    for (const ref of ['https://shop.example.com/?utm_source=x', 'https://shop.example.com/?twclid=', 'not a url twclid=abc']) {
      setPage('', ref);
      const a = new AttributionManager().captureAttribution() as any;
      expect(a.twclid).toBeUndefined();
      expect(a.clickId).toBeUndefined();
    }
  });

  test('marketing DECLINED strips the recovered twclid', () => {
    setPage('', 'https://shop.example.com/?twclid=ref_click');
    const data = new AttributionManager({ marketingAllowed: () => false }).getAttributionData() as any;
    expect(data.twclid).toBeUndefined();
    expect(data.clickId).toBeUndefined();
  });
});

describe('referrer host matching for X and LinkedIn (exact host or subdomain)', () => {
  beforeEach(() => { clearAll(); setPage('', ''); });
  afterEach(() => { clearAll(); });

  const sourceFor = (referrer: string): string => {
    setPage('', referrer);
    return new AttributionManager().captureAttribution().source as string;
  };

  test.each([
    ['https://t.co/abc', 'twitter'],
    ['https://x.com/someone/status/1', 'twitter'],
    ['https://twitter.com/someone', 'twitter'],
    ['https://mobile.twitter.com/someone', 'twitter'],
    ['https://mobile.x.com/someone', 'twitter'],
    ['https://www.linkedin.com/feed/', 'linkedin'],
    ['https://linkedin.com/in/someone', 'linkedin'],
    ['https://lnkd.in/abc', 'linkedin'],
    // Former false positives
    ['https://www.reddit.com/r/foo', 'reddit'],
    ['https://www.pinterest.com/pin/1', 'pinterest'],
    ['https://www.xbox.com/en-US', 'referral'],
    ['https://www.netflix.com/', 'referral'],
    ['https://www.box.com/', 'referral'],
    ['https://www.dropbox.com/s/abc', 'referral'],
    ['https://www.microsoft.com/', 'referral'],
    ['https://www.fedex.com/', 'referral'],
    ['https://notlinkedin.com/', 'referral'],
    ['https://linkedin.com.evil.test/', 'referral'],
    ['https://xlnkd.in/', 'referral'],
    ['https://twitter.co/', 'referral'],
  ])('determineSource: %s → %s', (referrer, source) => {
    expect(sourceFor(referrer)).toBe(source);
  });

  test.each([
    ['t.co', 'twitter'],
    ['x.com', 'twitter'],
    ['twitter.com', 'twitter'],
    ['mobile.twitter.com', 'twitter'],
    ['www.linkedin.com', 'linkedin'],
    ['lnkd.in', 'linkedin'],
    ['www.reddit.com', 'reddit'],
    ['www.pinterest.com', 'pinterest'],
    ['www.xbox.com', 'other'],
    ['www.netflix.com', 'other'],
    ['www.box.com', 'other'],
    ['www.dropbox.com', 'other'],
    ['www.microsoft.com', 'other'],
    ['notlinkedin.com', 'other'],
    ['linkedin.com.evil.test', 'other'],
  ])('getReferrerData referrer_source: %s → %s', (host, source) => {
    setPage('', `https://${host}/path`);
    expect(getReferrerData().referrer_source).toBe(source);
  });

  test('isHostOrSubdomain', () => {
    expect(isHostOrSubdomain('x.com', 'x.com')).toBe(true);
    expect(isHostOrSubdomain('MOBILE.Twitter.com', 'twitter.com')).toBe(true);
    expect(isHostOrSubdomain('x.com.', 'x.com')).toBe(true);
    expect(isHostOrSubdomain('xbox.com', 'x.com')).toBe(false);
    expect(isHostOrSubdomain('reddit.com', 't.co')).toBe(false);
    expect(isHostOrSubdomain('t.co.uk', 't.co')).toBe(false);
    expect(isHostOrSubdomain('', 'x.com')).toBe(false);
  });
});
