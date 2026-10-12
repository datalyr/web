/**
 * AppLovin pixel in the Container: loaded like AppLovin's native-JS snippet,
 * only with marketing consent and without DNT / GPC, never next to another
 * AppLovin install, and every axon("track") carries the dedupe_id the postback
 * worker's Conversion API sender puts on the server copy of the same event.
 */
import { createHash, webcrypto } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';
import {
  APPLOVIN_PIXEL_SCRIPTS,
  ContainerManager,
  appLovinDedupeId,
  appLovinEventAllowed,
  appLovinEventData,
  appLovinEventName,
  appLovinItems,
  appLovinNormalizedEmail,
  appLovinOrderReference,
  appLovinPixelOnPage,
} from './container';

const KEY = 'AxEvtKey_test-123';

function scripts(): string[] {
  return Array.from(document.querySelectorAll('script')).map((s) => s.src).filter(Boolean);
}
const appLovinScripts = () => scripts().filter((src) => APPLOVIN_PIXEL_SCRIPTS.includes(src));

/** Commands queued on AppLovin's stub (the vendor script never runs in jsdom). */
function axonCalls(): unknown[][] {
  const axon = (window as any).axon;
  return axon ? Array.from(axon.operationQueue as ArrayLike<ArrayLike<unknown>>).map((args) => Array.from(args)) : [];
}
const tracks = () => axonCalls().filter((call) => call[0] === 'track');

function respond(pixels: Record<string, unknown>): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ scripts: [], pixels }) });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function applovin(extra: Record<string, unknown> = {}) {
  return { applovin: { enabled: true, event_key: KEY, account_type: 'purchase', ...extra } };
}

function resetPage(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const key of ['axon', 'AXON_EVENT_KEY', 'Shopify', 'globalPrivacyControl', 'doNotTrack']) {
    try { delete (window as any)[key]; } catch { (window as any)[key] = undefined; }
  }
  delete (navigator as any).globalPrivacyControl;
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
}

async function started(options: { canForward?: () => boolean; getIdentity?: () => any } = {}): Promise<ContainerManager> {
  const manager = new ContainerManager({ workspaceId: 'ws', ...options });
  await manager.init();
  await (manager as any).appLovinInit;
  return manager;
}

describe('AppLovin pixel: loading and gating', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    // The page always has some script tag above ours, as on a real site.
    document.head.appendChild(document.createElement('script'));
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
    expect((window as any).AXON_EVENT_KEY).toBe(KEY);
    expect((window as any).axon.eventKey).toBe(KEY);
    expect(typeof (window as any).axon.ts).toBe('number');
    expect(appLovinScripts()).toEqual([...APPLOVIN_PIXEL_SCRIPTS]);
    const ours = Array.from(document.querySelectorAll('script')).filter((s) => APPLOVIN_PIXEL_SCRIPTS.includes(s.src));
    expect(ours.every((s) => s.async)).toBe(true);
    expect(axonCalls()).toEqual([['init']]);
  });

  test('loads once: a second init and later events never add scripts or re-init', async () => {
    respond(applovin());
    manager = await started();
    await manager.init();
    await manager.trackToPixels('pageview', {}, 'evt-1');
    await manager.trackToPixels('pageview', {}, 'evt-2');
    expect(appLovinScripts()).toHaveLength(2);
    expect(axonCalls().filter((call) => call[0] === 'init')).toHaveLength(1);
  });

  test('no marketing consent: nothing loads and nothing is sent', async () => {
    const fetchMock = respond(applovin());
    manager = await started({ canForward: () => false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((window as any).axon).toBeUndefined();
    expect(appLovinScripts()).toHaveLength(0);
    expect(await manager.trackToPixels('purchase', { value: 5, order_id: '1' }, 'evt')).toEqual([]);
  });

  test('consent withdrawn after load: later events are not sent', async () => {
    respond(applovin());
    let allowed = true;
    manager = await started({ canForward: () => allowed });
    allowed = false;
    expect(await manager.trackToPixels('add_to_cart', { product_id: 'p1' }, 'evt')).toEqual([]);
    expect(tracks()).toHaveLength(0);
  });

  test.each([
    ['navigator.doNotTrack', () => Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })],
    ['window.globalPrivacyControl (dl.js fingerprint.dnt)', () => { (window as any).globalPrivacyControl = true; }],
    ['navigator.globalPrivacyControl (explicit GPC)', () => { (navigator as any).globalPrivacyControl = true; }],
  ])('%s set: the pixel never loads, whatever the site honors for analytics', async (_name, setSignal) => {
    setSignal();
    respond({ ...applovin(), whop: { enabled: true, company_id: 'biz_x' } });
    manager = await started();
    expect((window as any).axon).toBeUndefined();
    expect(appLovinScripts()).toHaveLength(0);
    expect((window as any).whop).toBeDefined(); // only AppLovin is held back
    expect(await manager.trackToPixels('pageview', {}, 'evt')).toEqual(['whop']);
    delete (window as any).whop;
  });

  test('a GPC signal appearing after load stops the browser copy', async () => {
    respond(applovin());
    manager = await started();
    (navigator as any).globalPrivacyControl = true;
    expect(await manager.trackToPixels('add_to_cart', { product_id: 'p1' }, 'evt')).toEqual([]);
    expect(tracks()).toHaveLength(0);
  });

  test('not configured, disabled, or without an event key: nothing loads', async () => {
    for (const pixels of [{}, { applovin: { enabled: false, event_key: KEY } }, { applovin: { enabled: true, event_key: '' } }]) {
      respond(pixels);
      manager = await started();
      expect((window as any).axon).toBeUndefined();
      manager.cleanupAllIframes();
    }
  });

  test('restricted lead-gen accounts never get the browser pixel', async () => {
    respond(applovin({ account_type: 'restricted_lead_gen' }));
    manager = await started();
    expect((window as any).axon).toBeUndefined();
  });

  test('the other pixels are not held while AppLovin decides', async () => {
    respond({ ...applovin(), whop: { enabled: true, company_id: 'biz_x' } });
    manager = new ContainerManager({ workspaceId: 'ws' });
    await manager.init();
    expect((window as any).whop).toBeDefined();
    delete (window as any).whop;
  });
});

describe('AppLovin pixel: another install already on the page', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
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
    expect(manager.isAppLovinCompanionMode()).toBe(true);
    expect(appLovinScripts()).toHaveLength(0);
    expect((window as any).AXON_EVENT_KEY).toBeUndefined();
    expect(await manager.trackToPixels('purchase', { value: 20, currency: 'USD', order_id: '42' }, 'evt')).toEqual([]);
    expect(theirs).not.toHaveBeenCalled();
  });

  test('the app embed snippet is in the HTML but has not run yet', async () => {
    // Parsed but not executed yet (jsdom would run a plain inline script).
    inline('var AXON_EVENT_KEY="' + KEY + '";!function(e,r){}(window,document);', 'text/plain');
    respond(applovin());
    manager = await started();
    expect(manager.isAppLovinCompanionMode()).toBe(true);
    expect((window as any).axon).toBeUndefined();
  });

  test("AppLovin's pixel script is already in the document", async () => {
    const script = document.createElement('script');
    script.src = 'https://s.axon.ai/pixel.js';
    document.head.appendChild(script);
    respond(applovin());
    manager = await started();
    expect(manager.isAppLovinCompanionMode()).toBe(true);
    expect((window as any).axon).toBeUndefined();
  });

  test("Shopify's web pixel config carries this Event Key (the app's web pixel)", async () => {
    const entry = String.raw`{"id":"77","configuration":"{\"eventKey\":\"` + KEY + String.raw`\",\"shop\":\"x\"}","eventPayloadVersion":"v1","runtimeContext":"STRICT","type":"APP","apiClientId":987654}`;
    inline('(function(){var wpmLoader=function(){};wpmLoader({shopId: 1,webPixelsConfigList: [' + entry + '],isMerchantRequest: false});})();');
    (window as any).Shopify = {};
    respond(applovin());
    manager = await started();
    expect(manager.isAppLovinCompanionMode()).toBe(true);
    expect((window as any).axon).toBeUndefined();
  });

  test('detection ignores unrelated pages and our own scripts', () => {
    expect(appLovinPixelOnPage(KEY)).toBe(false);
    inline('(function(){var wpmLoader=function(){};wpmLoader({webPixelsConfigList: [{"configuration":"{\\"pixelCode\\":\\"OTHER\\"}","apiClientId":1}]});})();');
    expect(appLovinPixelOnPage(KEY)).toBe(false);
    const ours = document.createElement('script');
    ours.src = APPLOVIN_PIXEL_SCRIPTS[0];
    ours.dataset.datalyrPixel = 'applovin';
    document.head.appendChild(ours);
    expect(appLovinPixelOnPage(KEY)).toBe(false);
  });
});

describe('AppLovin pixel: events', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => document.head.appendChild(document.createElement('script')));
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test('standard names, every track carries a dedupe_id; unmapped and internal events are not sent', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('pageview', {}, 'evt-page')).toEqual(['applovin']);
    await manager.trackToPixels('product_added', { product_id: 'p1', variant_id: 'v1', price: 10, quantity: 2, currency: 'eur' }, 'evt-cart');
    expect(await manager.trackToPixels('wishlist_shared', { product_id: 'p1' }, 'evt-custom')).toEqual([]);
    expect(await manager.trackToPixels('$identify', {}, 'evt-internal')).toEqual([]);
    expect(tracks()).toEqual([
      ['track', 'page_view', {}, { dedupe_id: 'evt-page' }],
      ['track', 'add_to_cart', {
        currency: 'EUR',
        items: [{ item_id: 'p1', item_variant_id: 'v1', price: 10, quantity: 2 }],
      }, { dedupe_id: 'evt-cart' }],
    ]);
  });

  test("purchase: dedupe_id is the order id exactly as data.transaction_id carries it; value is the subtotal", async () => {
    respond(applovin());
    manager = await started();
    await manager.trackToPixels('purchase', {
      order_id: 6896206413937, value: 118.5, subtotal: 100, shipping: 8.5, tax: 10, currency: 'USD',
      items: [{ product_id: 111, variant_id: 222, title: 'Tee', price: 50, quantity: 2 }],
    }, 'evt-purchase');
    expect(tracks()).toEqual([['track', 'purchase', {
      currency: 'USD', value: 100, shipping: 8.5, tax: 10, transaction_id: '6896206413937',
      items: [{ item_id: '111', item_variant_id: '222', item_name: 'Tee', price: 50, quantity: 2 }],
    }, { dedupe_id: '6896206413937' }]]);
  });

  test('purchase without an order id: transaction_id and dedupe_id are the DATALYR event id', async () => {
    respond(applovin());
    manager = await started();
    await manager.trackToPixels('order_completed', { value: 30, product_id: 'prod_1' }, 'evt-no-order');
    const [call] = tracks();
    expect(call[1]).toBe('purchase');
    expect((call[2] as any).transaction_id).toBe('evt-no-order');
    expect(call[3]).toEqual({ dedupe_id: 'evt-no-order' });
  });

  test('a $0 purchase and a lead without a value are not sent (the sender skips them too)', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('purchase', { value: 0, order_id: 'o1' }, 'e1')).toEqual([]);
    expect(await manager.trackToPixels('lead', {}, 'e2')).toEqual([]);
    expect(await manager.trackToPixels('lead', { value: 0 }, 'e3')).toEqual(['applovin']);
    expect(tracks()).toEqual([['track', 'generate_lead', { currency: 'USD', value: 0 }, { dedupe_id: 'e3' }]]);
  });

  test('an event with no event id is not sent (it could never merge with the server copy)', async () => {
    respond(applovin());
    manager = await started();
    expect(await manager.trackToPixels('add_to_cart', { product_id: 'p1' })).toEqual([]);
    // A purchase with an order id still has its id.
    expect(await manager.trackToPixels('purchase', { value: 9, order_id: 'A-1' })).toEqual(['applovin']);
    expect(tracks()[0][3]).toEqual({ dedupe_id: 'A-1' });
  });

  test("the workspace rule's name wins, through the current policy read", async () => {
    respond(applovin({ event_mappings: { checkout_step: 'begin_checkout', signup_done: 'complete_registration', odd: 'MyCustomEvent' } }));
    manager = await started();
    await manager.trackToPixels('checkout_step', { value: 40, currency: 'GBP', items: [{ id: 'x', price: 40 }] }, 'e1');
    await manager.trackToPixels('signup_done', { method: 'google' }, 'e2');
    expect(await manager.trackToPixels('odd', {}, 'e3')).toEqual([]);
    expect(tracks().map((call) => call[1])).toEqual(['begin_checkout', 'sign_up']);
  });

  test('lead-gen accounts send only page_view and generate_lead', async () => {
    respond(applovin({ account_type: 'lead_gen' }));
    manager = await started();
    await manager.trackToPixels('pageview', {}, 'e1');
    await manager.trackToPixels('purchase', { value: 5, order_id: 'o' }, 'e2');
    await manager.trackToPixels('lead', { value: 12 }, 'e3');
    expect(tracks().map((call) => call[1])).toEqual(['page_view', 'generate_lead']);
  });

  test('the current policy must still allow AppLovin with the same Event Key', async () => {
    respond(applovin());
    manager = await started();
    respond({ applovin: { enabled: true, event_key: 'another-key' } });
    expect(await manager.trackToPixels('pageview', {}, 'e1')).toEqual([]);
    respond({}); // e.g. the visitor is now in an excluded country, or the gate closed
    expect(await manager.trackToPixels('pageview', {}, 'e2')).toEqual([]);
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    expect(await manager.trackToPixels('pageview', {}, 'e3')).toEqual([]);
    expect(tracks()).toHaveLength(0);
  });

  test('purchase and sign_up carry the identified email hashed with AppLovin’s normalization', async () => {
    // jsdom may lack Web Crypto / TextEncoder: lend Node's for this test.
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
    respond(applovin());
    manager = await started({ getIdentity: () => ({ email: ' J..A.NE+work.more+extra@GMAIL.COM ' }) });
    await manager.trackToPixels('purchase', { value: 5, order_id: 'o1' }, 'e1');
    expect((tracks()[0][2] as any).user_data).toEqual({
      email: '988b074286b20c503e3015c2076533f3bf4ce5ca6f8a507ab52c2e0f98d620b7',
    });
    restore.forEach((undo) => undo());
  });
});

describe('AppLovin mirrors of the sender contract', () => {
  test('event names: aliases, rule names, and no custom names', () => {
    expect(appLovinEventName('purchase')).toBe('purchase');
    expect(appLovinEventName('checkout_started')).toBe('begin_checkout');
    expect(appLovinEventName('trial_started')).toBe('subscribe');
    expect(appLovinEventName('pageview')).toBe('page_view');
    expect(appLovinEventName('Product_Viewed')).toBe('view_item');
    expect(appLovinEventName('custom_event')).toBeNull();
    expect(appLovinEventName('anything', { anything: 'Add_To_Cart' })).toBe('add_to_cart');
    expect(appLovinEventName('anything', { anything: 'initiate_checkout' })).toBe('begin_checkout');
    // A rule naming something non-standard is not sendable; it does not fall back to the event's own name.
    expect(appLovinEventName('purchase', { purchase: 'CompletePayment2' })).toBeNull();
    expect(appLovinEventAllowed('purchase', 'lead_gen')).toBe(false);
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

  test('purchase data: subtotal over value, shipping defaults to 0, tax only when recorded', () => {
    expect(appLovinEventData('purchase', 'purchase', { value: 50, order_id: 'o', items: [{ sku: 's', price: 50 }] }, 'e'))
      .toEqual({ currency: 'USD', value: 50, shipping: 0, transaction_id: 'o', items: [{ item_id: 's', price: 50, quantity: 1 }] });
    expect(appLovinEventData('purchase', 'purchase', { value: 50, price_id: 'price_1', product_id: 'prod_1' }, 'e'))
      .toMatchObject({ items: [{ item_id: 'prod_1', quantity: 1 }] });
    expect(appLovinEventData('purchase', 'purchase', { value: 50, price_id: 'price_1' }, 'e'))
      .toMatchObject({ items: [{ item_id: 'price_1', price: 50, quantity: 1 }] });
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
