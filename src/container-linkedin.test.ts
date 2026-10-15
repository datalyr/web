/**
 * LinkedIn Insight Tag in the Container, through the destination pixels module
 * (dl.pixels.<v>.js): loaded like LinkedIn's base code (_linkedin_partner_id,
 * _linkedin_data_partner_ids, the queueing lintrk stub, insight.min.js), only
 * with marketing consent and without DNT / GPC / a US opt-out, never next to
 * another Insight Tag install, and every lintrk('track') carries the
 * conversion id ingest lists and the DATALYR event_id the server sends as
 * eventId. Never a value, a currency or personal data; never page views.
 */
import { ContainerManager } from './container';
import { PIXELS_GLOBAL } from './destination-pixels';
import { createPixelsModule } from './pixels';
import { LINKEDIN_INSIGHT_SCRIPT, linkedInConversionIdFor, linkedInInsightTagOnPage } from './pixels/linkedin';
import { X_PIXEL_SCRIPT } from './pixels/x';

const PARTNER = '5137410';
const EVENTS = { signup: '777', demo_booked: 888, purchase: '999', pageview: '111', bad: 'urn:lla:llaPartnerConversion:1' };

function lintrkCalls(): unknown[][] {
  const lintrk = (window as any).lintrk;
  return lintrk && Array.isArray(lintrk.q) ? lintrk.q.map((args: unknown[]) => Array.from(args)) : [];
}
const tracks = () => lintrkCalls().filter((call) => call[0] === 'track');
const insightScripts = () => Array.from(document.querySelectorAll('script')).map((s) => s.src).filter((src) => src === LINKEDIN_INSIGHT_SCRIPT);

function respond(pixels: Record<string, unknown>): jest.Mock {
  const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ scripts: [], pixels }) }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
function linkedin(extra: Record<string, unknown> = {}) {
  return { linkedin: { enabled: true, partner_id: PARTNER, events: EVENTS, ...extra } };
}
function clearGlobal(key: string): void {
  try { delete (window as any)[key]; } catch { (window as any)[key] = undefined; }
}
function resetPage(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const key of ['lintrk', '_linkedin_partner_id', '_linkedin_data_partner_ids', '_already_called_lintrk', 'twq',
    'Shopify', 'globalPrivacyControl', '__uspapi', '__datalyrLandingPageView', PIXELS_GLOBAL]) clearGlobal(key);
  delete (navigator as any).globalPrivacyControl;
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
  document.cookie = 'usprivacy=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
}
/**
 * insight.min.js arriving: it marks itself run and replaces the stub with
 * LinkedIn's own lintrk. Recorded into the same queue so lintrkCalls() reads both.
 */
function insightLoads(): void {
  const stub = (window as any).lintrk;
  if (!stub || !stub.__datalyr) return;
  const own: any = (a: unknown, b: unknown) => { own.q.push([a, b]); };
  own.q = stub.q;
  (window as any).lintrk = own;
  (window as any)._already_called_lintrk = true;
}
async function started(options: { canForward?: () => boolean; insight?: boolean; debug?: boolean } = {}): Promise<ContainerManager> {
  const { insight = true, ...rest } = options;
  const manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10', ...rest });
  await manager.init();
  await manager.destinationPixelStatus('linkedin');
  if (insight) insightLoads();
  return manager;
}

describe('LinkedIn Insight Tag: loading and gating', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    document.head.appendChild(document.createElement('script'));
    (window as any)[PIXELS_GLOBAL] = createPixelsModule();
  });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test("loads like LinkedIn's base code: partner id, partner id list, lintrk stub, insight.min.js", async () => {
    respond(linkedin());
    manager = await started({ insight: false });
    expect(await manager.destinationPixelStatus('linkedin')).toBe('loaded');
    expect((window as any)._linkedin_partner_id).toBe(PARTNER);
    expect((window as any)._linkedin_data_partner_ids).toEqual([PARTNER]);
    expect(typeof (window as any).lintrk).toBe('function');
    expect((window as any).lintrk.q).toEqual([]);
    expect(insightScripts()).toEqual([LINKEDIN_INSIGHT_SCRIPT]);
    const script = document.querySelector(`script[src="${LINKEDIN_INSIGHT_SCRIPT}"]`) as HTMLScriptElement;
    expect(script.async).toBe(true);
    expect(script.dataset.datalyrPixel).toBe('linkedin');
  });

  test('page views never go out through lintrk (the base tag counts them)', async () => {
    respond(linkedin());
    manager = await started();
    expect(await manager.trackToPixels('pageview', {}, 'evt-1')).toEqual([]);
    expect(await manager.trackToPixels('page_view', {}, 'evt-2')).toEqual([]);
    expect(tracks()).toEqual([]);
  });

  test('no marketing consent: nothing loads, the module is not fetched', async () => {
    clearGlobal(PIXELS_GLOBAL);
    const fetchMock = respond(linkedin());
    manager = await started({ canForward: () => false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((window as any).lintrk).toBeUndefined();
    expect((window as any)._linkedin_partner_id).toBeUndefined();
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
  });

  test.each([
    ['DNT', () => Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })],
    ['GPC (window)', () => { (window as any).globalPrivacyControl = true; }],
    ['GPC (navigator)', () => { (navigator as any).globalPrivacyControl = true; }],
    ['us_privacy 1YYN', () => { document.cookie = 'usprivacy=1YYN; path=/'; }],
  ])('%s: the Insight Tag never loads', async (_name, setSignal) => {
    setSignal();
    respond(linkedin());
    manager = await started();
    expect((window as any).lintrk).toBeUndefined();
    expect(insightScripts()).toHaveLength(0);
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual([]);
  });

  test('no config, disabled, or a malformed partner id: nothing loads', async () => {
    for (const pixels of [{}, { linkedin: { enabled: false, partner_id: PARTNER } }, { linkedin: { enabled: true, partner_id: 'abc' } }]) {
      respond(pixels);
      manager = await started();
      expect((window as any).lintrk).toBeUndefined();
      expect((window as any)._linkedin_partner_id).toBeUndefined();
      manager.cleanupAllIframes();
    }
  });

  test('consent or a GPC signal withdrawn after load: later events are not sent', async () => {
    respond(linkedin());
    let allowed = true;
    manager = await started({ canForward: () => allowed });
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual(['linkedin']);
    allowed = false;
    expect(await manager.trackToPixels('signup', {}, 'e2')).toEqual([]);
    allowed = true;
    (navigator as any).globalPrivacyControl = true;
    expect(await manager.trackToPixels('signup', {}, 'e3')).toEqual([]);
    expect(tracks()).toHaveLength(1);
  });

  test('insight.min.js blocked (never runs): the event waits in the queue and is not reported delivered, logged once', async () => {
    respond(linkedin());
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    manager = await started({ insight: false, debug: true });
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual([]);
    expect(await manager.trackToPixels('signup', {}, 'e2')).toEqual([]);
    expect(tracks()).toEqual([
      ['track', { conversion_id: 777, event_id: 'e1' }],
      ['track', { conversion_id: 777, event_id: 'e2' }],
    ]);
    expect(log.mock.calls.filter((call) => String(call[1]).includes('insight.min.js has not run'))).toHaveLength(1);
    log.mockRestore();
  });

  test('LinkedIn and X come from one module load', async () => {
    clearGlobal(PIXELS_GLOBAL);
    respond({ ...linkedin(), x: { enabled: true, pixel_id: 'q19sf', events: {} } });
    manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10' });
    await manager.init();
    const injected = Array.from(document.querySelectorAll('script')).filter((s) => s.dataset.datalyrPixel === 'module');
    expect(injected).toHaveLength(1);
    (window as any)[PIXELS_GLOBAL] = createPixelsModule();
    injected[0].dispatchEvent(new Event('load'));
    expect(await manager.destinationPixelStatus('linkedin')).toBe('loaded');
    expect(await manager.destinationPixelStatus('x')).toBe('loaded');
    expect(insightScripts()).toHaveLength(1);
    expect(Array.from(document.querySelectorAll('script')).filter((s) => s.src === X_PIXEL_SCRIPT)).toHaveLength(1);
  });
});

describe('LinkedIn Insight Tag: another install already on the page', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => { (window as any)[PIXELS_GLOBAL] = createPixelsModule(); });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });
  function inline(text: string, type?: string): void {
    const script = document.createElement('script');
    if (type) script.type = type;
    script.text = text;
    document.body.appendChild(script);
  }

  test('window.lintrk already there (theme code, GTM, an app): no second tag, nothing sent through it', async () => {
    const theirs: any = jest.fn();
    (window as any).lintrk = theirs;
    respond(linkedin());
    manager = await started();
    expect(await manager.destinationPixelStatus('linkedin')).toBe('companion');
    expect(insightScripts()).toHaveLength(0);
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual([]);
    expect(theirs).not.toHaveBeenCalled();
  });

  test.each([
    ['another partner id in _linkedin_data_partner_ids', () => { (window as any)._linkedin_data_partner_ids = ['42']; }],
    ['our partner id already pushed by their snippet', () => { (window as any)._linkedin_data_partner_ids = [PARTNER]; }],
    ['_linkedin_partner_id set', () => { (window as any)._linkedin_partner_id = '42'; }],
    ['their insight.min.js as a script src', () => { const s = document.createElement('script'); s.src = LINKEDIN_INSIGHT_SCRIPT; document.head.appendChild(s); }],
    ["LinkedIn's base code inline, not run yet", () => inline('_linkedin_partner_id = "42"; window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || []; window._linkedin_data_partner_ids.push(_linkedin_partner_id);', 'text/plain')],
    ["Shopify's web pixel config carries the partner id as a number", () => {
      inline(JSON.stringify({ webPixelsConfigList: [{ id: '2', type: 'APP', configuration: JSON.stringify({ partnerId: Number(PARTNER) }) }] }), 'application/json');
    }],
    ["Shopify's web pixel config carries the partner id", () => {
      inline(JSON.stringify({ webPixelsConfigList: [{ id: '1', type: 'APP', configuration: JSON.stringify({ partnerId: PARTNER }) }] }), 'application/json');
    }],
  ])('companion: %s', async (_name, arrange) => {
    arrange();
    respond(linkedin());
    manager = await started();
    expect(await manager.destinationPixelStatus('linkedin')).toBe('companion');
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual([]);
  });

  test('detection matches the base code itself, not mentions of insight.min.js', () => {
    inline("var urls=['https://snap.licdn.com/li.lms-analytics/insight.min.js'];", 'text/plain');
    expect(linkedInInsightTagOnPage(PARTNER)).toBe(false);
    const ours = document.createElement('script');
    ours.src = LINKEDIN_INSIGHT_SCRIPT;
    ours.dataset.datalyrPixel = 'linkedin';
    document.head.appendChild(ours);
    expect(linkedInInsightTagOnPage(PARTNER)).toBe(false);
    expect(linkedInInsightTagOnPage(PARTNER, [{ configuration: { partnerId: PARTNER } }])).toBe(true);
    expect(linkedInInsightTagOnPage(PARTNER, [{ configuration: { partnerId: '42' } }])).toBe(false);
    // A numeric partner id, as an object value or inside a JSON string.
    expect(linkedInInsightTagOnPage(PARTNER, [{ configuration: { partnerId: Number(PARTNER) } }])).toBe(true);
    expect(linkedInInsightTagOnPage(PARTNER, [{ configuration: JSON.stringify({ tag: { partnerId: Number(PARTNER) } }) }])).toBe(true);
    expect(linkedInInsightTagOnPage(PARTNER, [{ configuration: { partnerId: 42 } }])).toBe(false);
  });

  test.each([
    ['a GTM tag adds insight.min.js', () => { const s = document.createElement('script'); s.src = LINKEDIN_INSIGHT_SCRIPT; document.head.appendChild(s); }],
    ['another install replaces window.lintrk', () => { (window as any).lintrk = jest.fn(); }],
    ['another partner id joins the page', () => { (window as any)._linkedin_data_partner_ids.push('42'); }],
  ])('a late install (%s): forwarding stops', async (_name, arrive) => {
    respond(linkedin());
    manager = await started();
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual(['linkedin']);
    arrive();
    expect(await manager.trackToPixels('signup', {}, 'e2')).toEqual([]);
    expect(await manager.trackToPixels('signup', {}, 'e3')).toEqual([]);
  });

  test("a lintrk replaced without insight.min.js having run is foreign (not LinkedIn's own)", async () => {
    respond(linkedin());
    manager = await started({ insight: false });
    const other: any = jest.fn();
    (window as any).lintrk = other;
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual([]);
    expect(other).not.toHaveBeenCalled();
  });
});

describe('LinkedIn Insight Tag: events', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    document.head.appendChild(document.createElement('script'));
    (window as any)[PIXELS_GLOBAL] = createPixelsModule();
  });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test('only listed events, as lintrk track with the numeric conversion id and the DATALYR event_id; nothing else', async () => {
    respond(linkedin());
    manager = await started();
    expect(await manager.trackToPixels('signup', { email: 'a@b.co', value: 40, currency: 'EUR', phone: '+15555550100' }, 'evt-signup')).toEqual(['linkedin']);
    expect(await manager.trackToPixels('demo_booked', {}, 'evt-demo', { data: { value: 5, currency: 'USD' } })).toEqual(['linkedin']);
    expect(await manager.trackToPixels('purchase', { order_id: 'O-1', value: 99, currency: 'USD' }, 'evt-p')).toEqual(['linkedin']);
    // Unlisted, malformed id, internal: nothing.
    expect(await manager.trackToPixels('lead', {}, 'e-x')).toEqual([]);
    expect(await manager.trackToPixels('bad', {}, 'e-bad')).toEqual([]);
    expect(await manager.trackToPixels('$identify', {}, 'e-int')).toEqual([]);
    expect(tracks()).toEqual([
      ['track', { conversion_id: 777, event_id: 'evt-signup' }],
      ['track', { conversion_id: 888, event_id: 'evt-demo' }],
      // event_id is the DATALYR event id even for a purchase with an order id (the server's eventId).
      ['track', { conversion_id: 999, event_id: 'evt-p' }],
    ]);
    expect(JSON.stringify(tracks())).not.toMatch(/a@b\.co|email|phone|value|currency|5555|O-1/);
  });

  test('no event id: not sent (the copies could never dedupe)', async () => {
    respond(linkedin());
    manager = await started();
    expect(await manager.trackToPixels('signup', {})).toEqual([]);
    expect(await manager.trackToPixels('purchase', { order_id: 'A-1', value: 2, currency: 'USD' })).toEqual([]);
    expect(tracks()).toEqual([]);
  });

  test("insight.min.js's own lintrk receives the events once it has run", async () => {
    respond(linkedin());
    manager = await started({ insight: false });
    const own: any = jest.fn();
    (window as any).lintrk = own;
    (window as any)._already_called_lintrk = true;
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual(['linkedin']);
    expect(own).toHaveBeenCalledWith('track', { conversion_id: 777, event_id: 'e1' });
  });

  test('a pixel-only co-fire (destinationPixels: false) never reaches LinkedIn', async () => {
    respond(linkedin());
    manager = await started();
    expect(await manager.trackToPixels('purchase', { order_id: 'CC-1', value: 5, currency: 'USD' }, 'cc', { destinationPixels: false })).toEqual([]);
    expect(tracks()).toEqual([]);
  });

  test('the current policy must still allow LinkedIn with the same partner id', async () => {
    respond(linkedin());
    manager = await started();
    respond(linkedin({ partner_id: '42' }));
    expect(await manager.trackToPixels('signup', {}, 'e1')).toEqual([]);
    respond({});
    expect(await manager.trackToPixels('signup', {}, 'e2')).toEqual([]);
    // A conversion id withdrawn from the current policy is not sent either.
    respond(linkedin({ events: {} }));
    expect(await manager.trackToPixels('signup', {}, 'e3')).toEqual([]);
    expect(tracks()).toHaveLength(0);
  });
});

describe('LinkedIn conversion ids', () => {
  test('digits (text or number) only, own keys only, safe integers only', () => {
    expect(linkedInConversionIdFor('a', { events: { a: '777' } })).toBe(777);
    expect(linkedInConversionIdFor('a', { events: { a: 777 } as any })).toBe(777);
    expect(linkedInConversionIdFor('a', { events: { a: ' 777 ' } })).toBe(777);
    expect(linkedInConversionIdFor('a', { events: { a: 'urn:lla:llaPartnerConversion:777' } })).toBeNull();
    expect(linkedInConversionIdFor('a', { events: { a: '99999999999999999999' } })).toBeNull();
    expect(linkedInConversionIdFor('toString', { events: {} })).toBeNull();
    expect(linkedInConversionIdFor('a', {})).toBeNull();
  });
});
