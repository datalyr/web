/**
 * AppLovin pixel in the Container, through the lazily loaded destination
 * pixels module (dl.pixels.<v>.js): loaded like AppLovin's native-JS snippet,
 * only with marketing consent and without DNT / GPC / a US opt-out, never next
 * to another AppLovin install, never for page views, only for events a website
 * AppLovin rule maps, and every axon("track") carries the dedupe_id the
 * postback sender puts on the server copy of the same event.
 */
import { createHash, webcrypto } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';
import { ContainerManager } from './container';
import { PIXELS_GLOBAL, pixelsModuleUrl } from './destination-pixels';
import { createPixelsModule } from './pixels';
import {
  APPLOVIN_PIXEL_SCRIPTS,
  appLovinDedupeId,
  appLovinEventAllowed,
  appLovinEventData,
  appLovinEventName,
  appLovinItems,
  appLovinNormalizedEmail,
  appLovinOrderReference,
  appLovinPixelOnPage,
} from './pixels/applovin';

const KEY = 'AxEvtKey_test-123';
const EVENTS = {
  purchase: 'purchase', order_completed: 'purchase', product_added: 'add_to_cart', checkout_step: 'begin_checkout',
  signup_done: 'sign_up', lead: 'generate_lead', pageview: 'page_view', odd: 'MyCustomEvent',
};

function scripts(): string[] {
  return Array.from(document.querySelectorAll('script')).map((s) => s.src).filter(Boolean);
}
const appLovinScripts = () => scripts().filter((src) => APPLOVIN_PIXEL_SCRIPTS.includes(src));

/** Commands queued on AppLovin's stub (the vendor script never runs in jsdom). */
function axonCalls(): unknown[][] {
  const axon = (window as any).axon;
  return axon && axon.operationQueue
    ? Array.from(axon.operationQueue as ArrayLike<ArrayLike<unknown>>).map((args) => Array.from(args)) : [];
}
const tracks = () => axonCalls().filter((call) => call[0] === 'track');

/**
 * Network for one test: /container-scripts answers `pixels`; AppLovin's pixel
 * config (b.applovin.com/v1/pixel/config) answers `applovinConfig`, or fails
 * when it is 'fail'. Default: what AppLovin returned live on 2026-10-12.
 */
function respond(pixels: Record<string, unknown>,
  applovinConfig: Record<string, unknown> | 'fail' = { autoEmailCapture: true, autoSpaPageView: true }): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).startsWith('https://b.applovin.com/v1/pixel/config')) {
      if (applovinConfig === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => applovinConfig };
    }
    return { ok: true, json: async () => ({ scripts: [], pixels }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
const configFetches = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://b.applovin.com/v1/pixel/config'));

function applovin(extra: Record<string, unknown> = {}) {
  return { applovin: { enabled: true, event_key: KEY, account_type: 'purchase', events: EVENTS, values: ['product_added', 'checkout_step', 'lead'], ...extra } };
}

function clearGlobal(key: string): void {
  try { delete (window as any)[key]; } catch { (window as any)[key] = undefined; }
}

function resetPage(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const key of ['axon', 'AXON_EVENT_KEY', 'Shopify', 'globalPrivacyControl', 'doNotTrack', '__uspapi', 'whop', PIXELS_GLOBAL]) clearGlobal(key);
  delete (navigator as any).globalPrivacyControl;
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
  document.cookie = 'usprivacy=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
}

/** The module as dl.pixels.<v>.js registers it (fresh per test). */
function registerModule() {
  const module = createPixelsModule();
  (window as any)[PIXELS_GLOBAL] = module;
  return module;
}

async function started(options: { canForward?: () => boolean; getIdentity?: () => any } = {}): Promise<ContainerManager> {
  const manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '9.9.9', ...options });
  await manager.init();
  await manager.destinationPixelStatus('applovin');
  return manager;
}

describe('AppLovin pixel: loading and gating', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    document.head.appendChild(document.createElement('script'));
    registerModule();
  });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test('loads exactly as the native snippet: event key, queueing stub, both scripts, then init', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('loaded');
    expect((window as any).AXON_EVENT_KEY).toBe(KEY);
    expect((window as any).axon.eventKey).toBe(KEY);
    expect(typeof (window as any).axon.ts).toBe('number');
    expect(appLovinScripts()).toEqual([...APPLOVIN_PIXEL_SCRIPTS]);
    const ours = Array.from(document.querySelectorAll('script')).filter((s) => APPLOVIN_PIXEL_SCRIPTS.includes(s.src));
    expect(ours.every((s) => s.async)).toBe(true);
    expect(axonCalls()).toEqual([['init']]);
  });

  test('loads once; the landing page view is sent once, with its DATALYR event id as dedupe_id', async () => {
    const fetchMock = respond(applovin());
    manager = await started();
    await manager.init();
    expect(await manager.trackToPixels('pageview', { url: 'https://shop.example/' }, 'evt-landing', { landing: true })).toEqual(['applovin']);
    // Later page views on the same page load are SPA navigations: AppLovin's
    // pixel sends those itself (autoSpaPageView true), so we do not.
    expect(await manager.trackToPixels('pageview', {}, 'evt-spa-1')).toEqual([]);
    expect(await manager.trackToPixels('pageview', {}, 'evt-spa-2')).toEqual([]);
    expect(appLovinScripts()).toHaveLength(2);
    expect(axonCalls()).toEqual([['init'], ['track', 'page_view', {}, { dedupe_id: 'evt-landing' }]]);
    // AppLovin's config: read once per page, from the same endpoint its pixel uses.
    expect(configFetches(fetchMock).map(([url]) => url))
      .toEqual([`https://b.applovin.com/v1/pixel/config?event_key=${encodeURIComponent(KEY)}`]);
  });

  test('autoSpaPageView false: SPA page views are sent by us, each with its own event id', async () => {
    const fetchMock = respond(applovin(), { autoEmailCapture: false, autoSpaPageView: false });
    manager = await started();
    await manager.trackToPixels('pageview', {}, 'evt-landing', { landing: true });
    expect(await manager.trackToPixels('pageview', {}, 'evt-spa-1')).toEqual(['applovin']);
    expect(await manager.trackToPixels('pageview', {}, 'evt-spa-2')).toEqual(['applovin']);
    expect(tracks()).toEqual([
      ['track', 'page_view', {}, { dedupe_id: 'evt-landing' }],
      ['track', 'page_view', {}, { dedupe_id: 'evt-spa-1' }],
      ['track', 'page_view', {}, { dedupe_id: 'evt-spa-2' }],
    ]);
    expect(configFetches(fetchMock)).toHaveLength(1);
  });

  test.each([
    ['the config fetch fails', 'fail' as const],
    ['autoSpaPageView missing', { autoEmailCapture: true }],
  ])('%s: no SPA page views from us (never doubled), the landing one still goes', async (_name, config) => {
    respond(applovin(), config);
    manager = await started();
    await manager.trackToPixels('pageview', {}, 'evt-landing', { landing: true });
    expect(await manager.trackToPixels('pageview', {}, 'evt-spa')).toEqual([]);
    expect(tracks()).toEqual([['track', 'page_view', {}, { dedupe_id: 'evt-landing' }]]);
  });

  test('two dl.js installs on one page both claim the landing: only one is sent as such', async () => {
    respond(applovin());
    manager = await started();
    const results = await Promise.all([
      manager.trackToPixels('pageview', {}, 'evt-a', { landing: true }),
      manager.trackToPixels('pageview', {}, 'evt-b', { landing: true }),
    ]);
    expect(results.filter((delivered) => delivered.includes('applovin'))).toHaveLength(1);
    expect(tracks()).toHaveLength(1);
  });

  test('a page view without a page_view entry in the map, or without an event id, is not sent', async () => {
    respond(applovin({ events: { purchase: 'purchase' } }));
    manager = await started();
    expect(await manager.trackToPixels('pageview', {}, 'evt-landing', { landing: true })).toEqual([]);
    manager.cleanupAllIframes();
    resetPage();
    registerModule();
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('pageview', {}, undefined, { landing: true })).toEqual([]);
  });

  test('the landing is the first page view of the page load: dropped, it is still consumed (autoSpaPageView true)', async () => {
    respond(applovin());
    let allowed = false;
    manager = new ContainerManager({ workspaceId: 'ws', canForward: () => allowed });
    // The landing page view goes by before consent: never reaches the pixel.
    expect(await manager.trackToPixels('pageview', {}, 'evt-landing', { landing: true })).toEqual([]);
    allowed = true;
    await manager.init();
    await manager.destinationPixelStatus('applovin');
    // A later page view is an SPA navigation, not a late landing: AppLovin's
    // pixel sends those itself, so nothing from us.
    expect(await manager.trackToPixels('pageview', {}, 'evt-spa')).toEqual([]);
    expect(tracks()).toEqual([]);
  });

  test('no marketing consent: nothing loads, the module is not even fetched', async () => {
    clearGlobal(PIXELS_GLOBAL);
    const fetchMock = respond(applovin());
    manager = await started({ canForward: () => false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((window as any).axon).toBeUndefined();
    expect(scripts()).toHaveLength(0);
    expect(await manager.trackToPixels('purchase', { order_id: '1' }, 'evt')).toEqual([]);
  });

  test('consent withdrawn after load: later events are not sent', async () => {
    respond(applovin());
    let allowed = true;
    manager = await started({ canForward: () => allowed });
    allowed = false;
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'evt')).toEqual([]);
    expect(tracks()).toHaveLength(0);
  });

  test('consent missing when the decision is taken: decided again on a later event', async () => {
    clearGlobal(PIXELS_GLOBAL);
    respond(applovin());
    let allowed = true;
    manager = new ContainerManager({ workspaceId: 'ws', canForward: () => allowed });
    await manager.init();
    // The decision waits for the module; consent goes before it arrives.
    allowed = false;
    registerModule();
    document.querySelector<HTMLScriptElement>('script[data-datalyr-pixel="module"]')!.dispatchEvent(new Event('load'));
    expect(await manager.destinationPixelStatus('applovin')).toBe('retry');
    expect((window as any).axon).toBeUndefined();
    allowed = true;
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'evt-2')).toEqual(['applovin']);
    expect(await manager.destinationPixelStatus('applovin')).toBe('loaded');
  });

  test.each([
    ['navigator.doNotTrack', () => Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })],
    ['window.globalPrivacyControl (dl.js fingerprint.dnt)', () => { (window as any).globalPrivacyControl = true; }],
    ['navigator.globalPrivacyControl (explicit GPC)', () => { (navigator as any).globalPrivacyControl = true; }],
    ['us_privacy cookie 1YYN', () => { document.cookie = 'usprivacy=1YYN; path=/'; }],
    ['__uspapi 1YYY', () => { (window as any).__uspapi = (_c: string, _v: number, cb: any) => cb({ uspString: '1YYY' }, true); }],
  ])('%s: the pixel never loads, whatever the site honors for analytics', async (_name, setSignal) => {
    setSignal();
    respond({ ...applovin(), whop: { enabled: true, company_id: 'biz_x' } });
    manager = await started();
    expect((window as any).axon).toBeUndefined();
    expect(appLovinScripts()).toHaveLength(0);
    expect((window as any).whop).toBeDefined(); // only AppLovin is held back
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'evt')).toEqual([]);
  });

  test('a US opt-out that is not one (1YNN, 1---) does not block', async () => {
    document.cookie = 'usprivacy=1YNN; path=/';
    (window as any).__uspapi = (_c: string, _v: number, cb: any) => cb({ uspString: '1---' }, true);
    respond(applovin());
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('loaded');
  });

  test('a GPC signal appearing after load stops the browser copy', async () => {
    respond(applovin());
    manager = await started();
    (navigator as any).globalPrivacyControl = true;
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'evt')).toEqual([]);
    expect(tracks()).toHaveLength(0);
  });

  test('not configured, disabled, or without an event key: no module, nothing loads', async () => {
    clearGlobal(PIXELS_GLOBAL);
    for (const pixels of [{}, { applovin: { enabled: false, event_key: KEY } }, { applovin: { enabled: true, event_key: '' } }]) {
      respond(pixels);
      manager = await started();
      expect(scripts()).toHaveLength(0);
      expect((window as any).axon).toBeUndefined();
      manager.cleanupAllIframes();
    }
  });

  test('restricted lead-gen accounts never get the browser pixel', async () => {
    respond(applovin({ account_type: 'restricted_lead_gen' }));
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('blocked');
    expect((window as any).axon).toBeUndefined();
  });

  test('the module is injected once, from the versioned URL, only when configured', async () => {
    clearGlobal(PIXELS_GLOBAL);
    respond(applovin());
    manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10' });
    await manager.init();
    void manager.trackToPixels('product_added', { product_id: 'p1' }, 'e1');
    const injected = Array.from(document.querySelectorAll('script')).filter((s) => s.dataset.datalyrPixel === 'module');
    expect(injected.map((s) => s.src)).toEqual([pixelsModuleUrl('1.9.10')]);
    expect(pixelsModuleUrl('1.9.10')).toBe('https://track.datalyr.com/dl.pixels.1.9.10.js');
    // It arrives and registers itself: the pending decision and event go through.
    registerModule();
    injected[0].dispatchEvent(new Event('load'));
    expect(await manager.destinationPixelStatus('applovin')).toBe('loaded');
    expect(Array.from(document.querySelectorAll('script')).filter((s) => s.dataset.datalyrPixel === 'module')).toHaveLength(1);
  });

  test('a module that fails to load (blocked, 404) means no pixel and no error', async () => {
    clearGlobal(PIXELS_GLOBAL);
    respond(applovin());
    manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10' });
    await manager.init();
    const injected = Array.from(document.querySelectorAll('script')).find((s) => s.dataset.datalyrPixel === 'module')!;
    injected.dispatchEvent(new Event('error'));
    expect(await manager.destinationPixelStatus('applovin')).toBe('blocked');
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'e1')).toEqual([]);
  });
});

describe('AppLovin pixel: another install already on the page', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => registerModule());
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

  test('window.axon already initialised (the Shopify app embed ran): no second pixel, nothing sent through it', async () => {
    const theirs: any = jest.fn();
    theirs.eventKey = KEY;
    (window as any).axon = theirs;
    respond(applovin());
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('companion');
    expect(appLovinScripts()).toHaveLength(0);
    expect((window as any).AXON_EVENT_KEY).toBeUndefined();
    expect(await manager.trackToPixels('purchase', { order_id: '42' }, 'evt')).toEqual([]);
    expect(theirs).not.toHaveBeenCalled();
  });

  test("AppLovin's snippet is in the HTML but has not run yet", async () => {
    // Parsed but not executed yet (jsdom would run a plain inline script).
    inline('var AXON_EVENT_KEY="' + KEY + '";!function(e,r){}(window,document);', 'text/plain');
    respond(applovin());
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('companion');
    expect((window as any).axon).toBeUndefined();
  });

  test("AppLovin's pixel script is already a script src in the document", async () => {
    const script = document.createElement('script');
    script.src = 'https://res4.applovin.com/p/l/loader.iife.js';
    document.head.appendChild(script);
    respond(applovin());
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('companion');
  });

  test("Shopify's web pixel config carries this Event Key (the app's web pixel)", async () => {
    const entry = String.raw`{"id":"77","configuration":"{\"eventKey\":\"` + KEY + String.raw`\",\"shop\":\"x\"}","eventPayloadVersion":"v1","runtimeContext":"STRICT","type":"APP","apiClientId":987654}`;
    inline('(function(){var wpmLoader=function(){};wpmLoader({shopId: 1,webPixelsConfigList: [' + entry + '],isMerchantRequest: false});})();');
    (window as any).Shopify = {};
    respond(applovin());
    manager = await started();
    expect(await manager.destinationPixelStatus('applovin')).toBe('companion');
  });

  test('detection matches the snippet itself, not mentions of it (e.g. inside an inlined dl.js)', () => {
    expect(appLovinPixelOnPage(KEY)).toBe(false);
    inline('/* bundle */ var urls=["https://s.axon.ai/pixel.js"]; host.AXON_EVENT_KEY = key;', 'text/plain');
    expect(appLovinPixelOnPage(KEY)).toBe(false);
    const ours = document.createElement('script');
    ours.src = APPLOVIN_PIXEL_SCRIPTS[0];
    ours.dataset.datalyrPixel = 'applovin';
    document.head.appendChild(ours);
    expect(appLovinPixelOnPage(KEY)).toBe(false);
    inline('var  AXON_EVENT_KEY = "x";', 'text/plain');
    expect(appLovinPixelOnPage(KEY)).toBe(true);
  });

  test.each([
    ['a GTM tag adds AppLovin\'s script', () => {
      const s = document.createElement('script'); s.src = 'https://s.axon.ai/pixel.js'; document.head.appendChild(s);
    }],
    ['another snippet resets AXON_EVENT_KEY', () => { (window as any).AXON_EVENT_KEY = 'their-key'; }],
    ['another install replaces window.axon', () => { (window as any).axon = jest.fn(); }],
  ])('a late install (%s): forwarding stops', async (_name, arrive) => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'e1')).toEqual(['applovin']);
    arrive();
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'e2')).toEqual([]);
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' }, 'e3')).toEqual([]);
  });
});

describe('AppLovin pixel: events', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    document.head.appendChild(document.createElement('script'));
    registerModule();
  });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test('only events a website AppLovin rule maps, under the rule\'s name; every track carries a dedupe_id', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('product_added', { product_id: 'p1', variant_id: 'v1', price: 10, quantity: 2, currency: 'eur', value: 20 }, 'evt-cart')).toEqual(['applovin']);
    await manager.trackToPixels('checkout_step', { value: 40, currency: 'GBP', items: [{ id: 'x', price: 40 }] }, 'evt-co');
    await manager.trackToPixels('signup_done', { method: 'google' }, 'evt-su');
    // Not in the rule map (even a standard name), a non-standard rule name, internal events.
    expect(await manager.trackToPixels('add_to_cart', { product_id: 'p1' }, 'e-x')).toEqual([]);
    expect(await manager.trackToPixels('odd', {}, 'e-odd')).toEqual([]);
    expect(await manager.trackToPixels('$identify', {}, 'e-int')).toEqual([]);
    expect(tracks()).toEqual([
      ['track', 'add_to_cart', {
        currency: 'EUR', value: 20,
        items: [{ item_id: 'p1', item_variant_id: 'v1', price: 10, quantity: 2 }],
      }, { dedupe_id: 'evt-cart' }],
      ['track', 'begin_checkout', { currency: 'GBP', value: 40, items: [{ item_id: 'x', price: 40, quantity: 1 }] }, { dedupe_id: 'evt-co' }],
      ['track', 'sign_up', { method: 'google' }, { dedupe_id: 'evt-su' }],
    ]);
  });

  test('purchase: sent only as strong as the server copy; dedupe_id = the order reference exactly as transaction_id', async () => {
    respond(applovin({ values: ['purchase'] }));
    manager = await started();
    // No order reference, a $0 value, no currency of its own: left to the server.
    expect(await manager.trackToPixels('purchase', { value: 50, currency: 'USD' }, 'evt-no-order')).toEqual([]);
    expect(await manager.trackToPixels('purchase', { order_id: 'o0', value: 0, currency: 'USD' }, 'e0')).toEqual([]);
    expect(await manager.trackToPixels('purchase', { order_id: 'o1', value: 30 }, 'e1')).toEqual([]);
    await manager.trackToPixels('purchase', {
      order_id: 6896206413937, value: 118.5, subtotal: 100, shipping: 8.5, tax: 10, currency: 'eur',
      items: [{ product_id: 111, variant_id: 222, title: 'Tee', price: 50, quantity: 2 }],
    }, 'evt-purchase');
    expect(tracks()).toEqual([['track', 'purchase', {
      currency: 'EUR', value: 100, shipping: 8.5, tax: 10, transaction_id: '6896206413937',
      items: [{ item_id: '111', item_variant_id: '222', item_name: 'Tee', price: 50, quantity: 2 }],
    }, { dedupe_id: '6896206413937' }]]);
  });

  test('purchase in a workspace whose purchase value the server would not take from the browser: not sent at all', async () => {
    respond(applovin({ values: [] })); // verified money source, or a rule with its own value
    manager = await started();
    expect(await manager.trackToPixels('purchase', { order_id: 'A-1', value: 118.5, currency: 'USD' }, 'e1')).toEqual([]);
    expect(tracks()).toEqual([]);
  });

  test('ids come from the raw properties: an order id sanitising would alter is sent as the server has it', async () => {
    respond(applovin({ values: ['purchase'] }));
    manager = await started();
    await manager.trackToPixels('purchase', { order_id: 'ORD<7>onx=1', value: 5, currency: 'USD' }, 'e1');
    const [call] = tracks();
    expect((call[2] as any).transaction_id).toBe('ORD<7>onx=1');
    expect(call[3]).toEqual({ dedupe_id: 'ORD<7>onx=1' });
  });

  test('a pixel-only co-fire (destinationPixels: false) never reaches AppLovin', async () => {
    respond(applovin({ values: ['purchase'] }));
    manager = await started();
    expect(await manager.trackToPixels('purchase', { order_id: 'CC-1', value: 5, currency: 'USD' }, 'checkoutchamp_purchase_CC-1',
      { destinationPixels: false })).toEqual([]);
    expect(tracks()).toEqual([]);
  });

  test('a lead: with a value only when allowed (then a missing value skips it, as the sender does)', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('lead', {}, 'e1')).toEqual([]);
    expect(await manager.trackToPixels('lead', { value: 0 }, 'e2')).toEqual(['applovin']);
    manager.cleanupAllIframes();
    resetPage();
    registerModule();
    respond(applovin({ values: [] }));
    manager = await started();
    expect(await manager.trackToPixels('lead', { value: 99 }, 'e3')).toEqual(['applovin']);
    expect(tracks()).toEqual([['track', 'generate_lead', { currency: 'USD' }, { dedupe_id: 'e3' }]]);
  });

  test('an event with no event id is not sent (it could never merge with the server copy)', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('product_added', { product_id: 'p1' })).toEqual([]);
  });

  test('lead-gen accounts send only page_view and generate_lead', async () => {
    respond(applovin({ account_type: 'lead_gen' }));
    manager = await started();
    await manager.trackToPixels('pageview', {}, 'e1', { landing: true });
    await manager.trackToPixels('purchase', { order_id: 'o', value: 5, currency: 'USD' }, 'e2');
    await manager.trackToPixels('lead', { value: 12 }, 'e3');
    expect(tracks().map((call) => call[1])).toEqual(['page_view', 'generate_lead']);
  });

  test('the current policy must still allow AppLovin with the same Event Key, and its map applies', async () => {
    respond(applovin());
    manager = await started();
    respond(applovin({ events: { product_added: 'view_item' } }));
    await manager.trackToPixels('product_added', { product_id: 'p' }, 'e0');
    expect(tracks().map((call) => call[1])).toEqual(['view_item']);
    respond({ applovin: { enabled: true, event_key: 'another-key', events: EVENTS } });
    expect(await manager.trackToPixels('product_added', {}, 'e1')).toEqual([]);
    respond({}); // e.g. the visitor is now in an excluded country, or the gate closed
    expect(await manager.trackToPixels('product_added', {}, 'e2')).toEqual([]);
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    expect(await manager.trackToPixels('product_added', {}, 'e3')).toEqual([]);
    expect(tracks()).toHaveLength(1);
  });

  test('purchase and sign_up carry the identified email hashed with AppLovin’s normalization', async () => {
    const restore: Array<() => void> = [];
    if (!(globalThis as any).crypto?.subtle) {
      const prior = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
      restore.push(() => (prior ? Object.defineProperty(globalThis, 'crypto', prior) : delete (globalThis as any).crypto));
    }
    if (typeof (globalThis as any).TextEncoder === 'undefined') {
      (globalThis as any).TextEncoder = NodeTextEncoder;
      restore.push(() => delete (globalThis as any).TextEncoder);
    }
    respond(applovin({ values: ['purchase'] }));
    manager = await started({ getIdentity: () => ({ email: ' J..A.NE+work.more+extra@GMAIL.COM ' }) });
    await manager.trackToPixels('purchase', { order_id: 'o1', value: 9, currency: 'USD' }, 'e1');
    expect((tracks()[0][2] as any).user_data).toEqual({
      email: '988b074286b20c503e3015c2076533f3bf4ce5ca6f8a507ab52c2e0f98d620b7',
    });
    restore.forEach((undo) => undo());
  });
});

describe('AppLovin mirrors of the sender contract', () => {
  test('event names come from the map only; no custom names', () => {
    const config = { events: { a: 'Add_To_Cart', b: 'CompletePayment', c: 'page_view', d: 'purchase' } };
    expect(appLovinEventName('a', config)).toBe('add_to_cart');
    expect(appLovinEventName('b', config)).toBeNull();
    expect(appLovinEventName('c', config)).toBe('page_view');
    expect(appLovinEventName('c', { ...config, account_type: 'lead_gen' })).toBe('page_view');
    expect(appLovinEventName('purchase', config)).toBeNull(); // not mapped: not sent
    expect(appLovinEventName('d', { ...config, account_type: 'lead_gen' })).toBeNull();
    expect(appLovinEventName('toString', config)).toBeNull();
    expect(appLovinEventAllowed('generate_lead', 'lead_gen')).toBe(true);
    expect(appLovinEventAllowed('page_view', 'restricted_lead_gen')).toBe(false);
    expect(appLovinEventAllowed('purchase', undefined)).toBe(true);
  });

  // The examples documented on applovin-payload.js appLovinDedupeId.
  test.each([
    [{ eventName: 'purchase', transactionId: '6896206413937' }, '6896206413937'],
    [{ eventName: 'purchase', transactionId: 6896206413937 }, '6896206413937'],
    [{ eventName: 'purchase', transactionId: 'in_1Q2w3E' }, 'in_1Q2w3E'],
    [{ eventName: 'purchase', transactionId: 'shopify_42' }, 'shopify_42'],
    [{ eventName: 'add_to_cart', eventId: 'evt_7c1b' }, 'evt_7c1b'],
    [{ eventName: 'purchase', eventId: 'evt_9d2e' }, 'evt_9d2e'],
    [{ eventName: 'add_to_cart', eventId: 'evt_x', transactionId: 'order-1' }, 'evt_x'],
    [{ eventName: 'purchase', eventId: 'evt_y', transactionId: '  ' }, 'evt_y'],
  ])('dedupe_id %p → %p', (input, expected) => {
    expect(appLovinDedupeId(input as any)).toBe(expected);
  });

  test('order reference: the sender’s keys in the sender’s order', () => {
    expect(appLovinOrderReference({ transaction_id: 't', order_id: 'o' })).toBe('o');
    expect(appLovinOrderReference({ transaction_id: ' t ' })).toBe('t');
    expect(appLovinOrderReference({ object: 'invoice', id: 'in_1', charge: 'ch_1' })).toBe('in_1');
    expect(appLovinOrderReference({ invoice_id: 'in_2', charge: 'ch_2' })).toBe('in_2');
    expect(appLovinOrderReference({ object: 'charge', id: 'ch_3', payment_intent: 'pi_3' })).toBe('ch_3');
    expect(appLovinOrderReference({ payment_intent: 'pi_4' })).toBe('pi_4');
    expect(appLovinOrderReference({ checkout_id: 'co_5' })).toBe('co_5');
    expect(appLovinOrderReference({ id: 'x' })).toBeUndefined();
  });

  test('purchase data: no reference → not sent; shipping defaults to 0; tax only when recorded; synthesized item', () => {
    expect(appLovinEventData('purchase', 'purchase', { value: 50, currency: 'USD' }, { sendValue: true })).toBeNull();
    expect(appLovinEventData('purchase', 'purchase', { value: 50, currency: 'usd', order_id: 'o', items: [{ sku: 's', price: 50 }] }, { sendValue: true }))
      .toEqual({ currency: 'USD', value: 50, shipping: 0, transaction_id: 'o', items: [{ item_id: 's', price: 50, quantity: 1 }] });
    // Without sendValue, or without the event's own currency: left to the server.
    expect(appLovinEventData('purchase', 'purchase', { value: 50, currency: 'USD', order_id: 'o', product_id: 'prod_1' })).toBeNull();
    expect(appLovinEventData('purchase', 'purchase', { value: 50, order_id: 'o', product_id: 'prod_1' }, { sendValue: true })).toBeNull();
    // An explicit raw reference wins over the (sanitised) properties.
    expect(appLovinEventData('purchase', 'purchase', { value: 5, currency: 'USD', order_id: 'ORD' }, { sendValue: true, orderReference: 'ORD<7>' }))
      .toMatchObject({ transaction_id: 'ORD<7>' });
    expect(appLovinEventData('purchase', 'purchase', { value: 50, currency: 'USD', order_id: 'o', price_id: 'price_1', plan: { product: 'prod_2' } }, { sendValue: true }))
      .toMatchObject({ value: 50, items: [{ item_id: 'prod_2', item_variant_id: 'price_1', price: 50, quantity: 1 }] });
    expect(appLovinEventData('page_view', 'pageview', { value: 3 }, { sendValue: true })).toEqual({});
    expect(appLovinEventData('subscribe', 'trial_started', { trial_expected_value: 30 }, { sendValue: true })).toEqual({ currency: 'USD', value: 30 });
    expect(appLovinEventData('subscribe', 'trial_started', { trial_expected_value: 30 })).toEqual({ currency: 'USD' });
  });

  test('items: a line discount is spread over the units; bad images and categories are dropped', () => {
    expect(appLovinItems({ line_items: [{ product_id: 1, variant_id: 1, price: '20', quantity: 2, total_discount: 4, image_url: 'https://x/a.gif', item_category_id: 1.5 }] }))
      .toEqual([{ item_id: '1', price: 18, discount: 2, quantity: 2 }]);
    expect(appLovinItems({ product_id: 'p', product_title: 'Mug', price: 12, image_url: 'https://cdn/x.jpg' }))
      .toEqual([{ item_id: 'p', item_name: 'Mug', price: 12, quantity: 1, image_url: 'https://cdn/x.jpg' }]);
    expect(appLovinItems({})).toEqual([]);
  });

  test("email normalization matches AppLovin's reference vectors", () => {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(sha(appLovinNormalizedEmail('Alice@Example.COM')!))
      .toBe('ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976');
    expect(sha(appLovinNormalizedEmail('J..A.NE+work.more+extra@GMAIL.COM')!))
      .toBe('988b074286b20c503e3015c2076533f3bf4ce5ca6f8a507ab52c2e0f98d620b7');
    expect(sha(appLovinNormalizedEmail('Jane.Doe+Work@GoogleMail.com')!))
      .toBe('338abf9ef1c8793cadc7bcf51ed595338eb727ed9e06ce3d91d566d60b975937');
    expect(appLovinNormalizedEmail('jöe@example.com')).toBeNull();
    expect(appLovinNormalizedEmail('a@b@c')).toBeNull();
    expect(appLovinNormalizedEmail('+x@gmail.com')).toBeNull();
  });
});
