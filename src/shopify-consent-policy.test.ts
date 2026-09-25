/**
 * The merchant's choice not to wait for Shopify cookie consent
 * (waitForShopifyConsent: false, set in the dashboard) and the Shopify cart
 * pairing report.
 *
 * On a Shopify store that requires consent, the SDK holds everything until the
 * Customer Privacy API allows it. When the store has no banner, that is never.
 * The merchant's setting has to reach the SDK BEFORE consent (the container
 * envelope only arrives after it), so it is fetched from /sdk-consent-policy.
 * A visitor who actively declined is never tracked either way.
 */
export {}; // module scope: index.test.ts declares the same helper names globally

import { shopifyCartId } from './shopify-cart';

type SdkModule = typeof import('./index');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

const CART_ID = 'hWNH9Y6FdVrLgn7ZJ5mpqZ0i';
const CART_KEY = '1c8f35be87e0ebf01a3595872887b0f5';

function mockNetwork(policy: Record<string, unknown> | null | 'error'): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/sdk-consent-policy')) {
      if (policy === 'error') throw new Error('network down');
      if (policy === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => policy };
    }
    if (target.includes('/cart/update.js')) {
      return { ok: true, status: 200, json: async () => ({ token: `${CART_ID}?key=${CART_KEY}`, attributes: {} }) };
    }
    if (target.includes('/container-scripts')) {
      return { ok: true, status: 200, json: async () => ({ scripts: [], pixels: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A Shopify store whose Customer Privacy API never answers (consent required, no banner). */
function stubShopifyNeverAnswers(): void {
  (window as any).Shopify = { loadFeatures: () => undefined };
}

/** A Shopify store whose Customer Privacy API is loaded with the given answers. */
function stubShopifyAnswers(opts: {
  analyticsAllowed: boolean;
  marketingAllowed: boolean;
  visitor: { analytics: string; marketing: string };
}): void {
  (window as any).Shopify = {
    loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => callback(),
    customerPrivacy: {
      analyticsProcessingAllowed: () => opts.analyticsAllowed,
      marketingAllowed: () => opts.marketingAllowed,
      currentVisitorConsent: () => ({ ...opts.visitor, preferences: '', sale_of_data: '' }),
    },
  };
}

/** The `_cmp` Server-Timing value Shopify sends with the page (observed on dainti.shop). */
// jsdom has no getEntriesByType; defined per test and removed in afterEach.
function stubServerTimingConsent(description: string): void {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: (type: string) => (type === 'navigation' ? [{ serverTiming: [{ name: '_cmp', description, duration: 0 }] }] : []),
  });
}

const baseConfig = {
  workspaceId: 'ws-consent-policy',
  platform: 'shopify' as const,
  enableFingerprinting: false,
  enablePerformanceTracking: false,
  enableContainer: false,
  trackPageViews: true,
  trackSPA: false,
  shopifyCartAttributes: false,
  stripePaymentLinks: false,
  stripeCheckoutSessions: false,
  inAppHandoff: false,
};

function tracked(enqueue: jest.SpyInstance): string[] {
  return enqueue.mock.calls.map((call: any[]) => call[0].event_name);
}

describe('waitForShopifyConsent: false (merchant does not wait for Shopify consent)', () => {
  const originalFetch = global.fetch;
  let instance: any;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    instance?.destroy();
    instance = undefined;
    global.fetch = originalFetch;
    delete (window as any).Shopify;
    delete (window as any).datalyr;
    delete (performance as any).getEntriesByType;
    document.cookie = 'cart=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    localStorage.clear();
    jest.restoreAllMocks();
  });

  // Spy right after init(): anything the policy releases is enqueued later,
  // once the /sdk-consent-policy response resolves.
  async function boot(config: Record<string, unknown> = baseConfig, waitMs = 20): Promise<jest.SpyInstance> {
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.shopifyConsentOverrideWaitMs = waitMs;
    instance.init(config);
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    return enqueue;
  }

  test('default: a store that never answers holds the landing pageview (unchanged behaviour)', async () => {
    mockNetwork({ waitForShopifyConsent: true });
    stubShopifyNeverAnswers();
    const enqueue = await boot();
    expect(tracked(enqueue)).not.toContain('pageview');
  });

  test('merchant chose not to wait, store never answers: held for the API, then released once', async () => {
    const fetchMock = mockNetwork({ waitForShopifyConsent: false });
    stubShopifyNeverAnswers();
    const enqueue = await boot(baseConfig, 60);
    expect(tracked(enqueue)).not.toContain('pageview'); // still inside the wait for the API
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    expect(tracked(enqueue).filter((name) => name === 'pageview')).toHaveLength(1);

    // The policy request carries nothing about the visitor.
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/sdk-consent-policy'))!;
    expect(String(url)).toBe('https://ingest.datalyr.com/sdk-consent-policy?ws=ws-consent-policy');
    expect(init).toEqual({ method: 'GET', credentials: 'omit' });
  });

  test.each([
    ['policy missing (404)', null],
    ['policy request fails', 'error' as const],
  ])('%s: keeps waiting', async (_name, policy) => {
    mockNetwork(policy);
    stubShopifyNeverAnswers();
    const enqueue = await boot();
    expect(tracked(enqueue)).not.toContain('pageview');
  });

  test('a visitor who DECLINED on an earlier page (Server-Timing _cmp) is never tracked, even after the wait', async () => {
    const fetchMock = mockNetwork({ waitForShopifyConsent: false });
    stubShopifyNeverAnswers();
    stubServerTimingConsent('3amps._GB_yBwjGjLGQe2j2oBUU9SleA_%7B%7D');
    const enqueue = await boot();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();
    expect(tracked(enqueue)).toHaveLength(0);
    // The answer is already known, so the policy is not even asked for.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/sdk-consent-policy'))).toBe(false);
  });

  test('no answer yet in the Server-Timing value (3.AMPS): released after the wait', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopifyNeverAnswers();
    stubServerTimingConsent('3.AMPS_GB_yBwjGjLGQe2j2oBUU9SleA_%7B%7D');
    const enqueue = await boot();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();
    expect(tracked(enqueue)).toContain('pageview');
  });

  test('a visitor who DECLINED in the loaded banner is never tracked', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopifyAnswers({ analyticsAllowed: false, marketingAllowed: false, visitor: { analytics: 'no', marketing: 'no' } });
    const enqueue = await boot();
    expect(tracked(enqueue)).toHaveLength(0);
  });

  test('no answer yet in a consent region (Shopify says "not allowed", visitor gave none): tracked', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopifyAnswers({ analyticsAllowed: false, marketingAllowed: false, visitor: { analytics: '', marketing: '' } });
    const enqueue = await boot();
    expect(tracked(enqueue)).toContain('pageview');
  });

  test('an explicit init() waitForShopifyConsent: true wins; the policy is not even fetched', async () => {
    const fetchMock = mockNetwork({ waitForShopifyConsent: false });
    stubShopifyNeverAnswers();
    const enqueue = await boot({ ...baseConfig, waitForShopifyConsent: true });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/sdk-consent-policy'))).toBe(false);
    expect(tracked(enqueue)).not.toContain('pageview');
  });

  test('not a Shopify storefront: no policy request', async () => {
    const fetchMock = mockNetwork({ waitForShopifyConsent: false });
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, platform: 'generic' });
    await instance.ready();
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/sdk-consent-policy'))).toBe(false);
  });
});

describe('Shopify cart pairing report', () => {
  const originalFetch = global.fetch;
  let instance: any;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    instance?.destroy();
    instance = undefined;
    global.fetch = originalFetch;
    delete (window as any).Shopify;
    delete (window as any).datalyr;
    document.cookie = 'cart=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    localStorage.clear();
    jest.restoreAllMocks();
  });

  async function bootStamping(): Promise<{ enqueue: jest.SpyInstance; fetchMock: jest.Mock }> {
    const fetchMock = mockNetwork({ waitForShopifyConsent: true });
    stubShopifyAnswers({ analyticsAllowed: true, marketingAllowed: true, visitor: { analytics: 'yes', marketing: 'yes' } });
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, shopifyCartAttributes: true });
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    return { enqueue, fetchMock };
  }

  test('reports the cart id, never the key, once per page', async () => {
    const { enqueue, fetchMock } = await bootStamping();
    const reports = enqueue.mock.calls.map((call: any[]) => call[0]).filter((p: any) => p.event_name === '$shopify_cart');
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).toContain(CART_ID);
    expect(JSON.stringify(reports[0])).not.toContain(CART_KEY);
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body ?? '')).not.toContain(CART_KEY);
    }

    // A second stamp (e.g. consent re-evaluation) with the same cart does not re-report.
    await instance.syncShopifyCartAttributes();
    const again = enqueue.mock.calls.filter((call: any[]) => call[0].event_name === '$shopify_cart');
    expect(again).toHaveLength(1);

    // An internal signal never takes the once-per-page Klaviyo binding.
    const consume = jest.spyOn(instance.attribution, 'consumeKlaviyoProfileBinding');
    instance.reportShopifyCart('aDifferentCartId0123456789');
    expect(consume).not.toHaveBeenCalled();
    instance.track('page_viewed_again');
    expect(consume).toHaveBeenCalledTimes(1);
  });

  test('no report when marketing consent is declined (stamping is gated the same way)', async () => {
    mockNetwork({ waitForShopifyConsent: true });
    stubShopifyAnswers({ analyticsAllowed: true, marketingAllowed: false, visitor: { analytics: 'yes', marketing: 'no' } });
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, shopifyCartAttributes: true });
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    expect(enqueue.mock.calls.some((call: any[]) => call[0].event_name === '$shopify_cart')).toBe(false);
  });

  // dainti order 7308784500784 (2026-09-24): one page view, an add to cart
  // through the store's cart widget 8s later, straight to checkout. The cart
  // reported at page load was not the cart the order came from.
  const WIDGET_CART = 'Wdgt9Y6FdVrLgn7ZJ5mpqZ0iXy';
  const cartReports = (enqueue: jest.SpyInstance) => enqueue.mock.calls
    .map((call: any[]) => call[0]).filter((p: any) => p.event_name === '$shopify_cart');

  test('a cart that changes after page load is reported on the next tracked event, once', async () => {
    const { enqueue } = await bootStamping();
    expect(cartReports(enqueue)).toHaveLength(1);
    document.cookie = `cart=${encodeURIComponent(`${WIDGET_CART}?key=${CART_KEY}`)}; path=/`;
    instance.track('add_to_cart', { value: 35 });
    const reports = cartReports(enqueue);
    expect(reports).toHaveLength(2);
    expect(JSON.stringify(reports[1])).toContain(WIDGET_CART);
    expect(JSON.stringify(reports[1])).not.toContain(CART_KEY);
    instance.track('view_item');
    expect(cartReports(enqueue)).toHaveLength(2);
  });

  test('leaving the page reports a changed cart before the queue flushes', async () => {
    const { enqueue } = await bootStamping();
    const flush = jest.spyOn(instance.queue, 'forceFlush');
    document.cookie = `cart=${encodeURIComponent(`${WIDGET_CART}?key=${CART_KEY}`)}; path=/`;
    window.dispatchEvent(new Event('pagehide'));
    const reportCall = enqueue.mock.calls.findIndex((call: any[]) => call[0].event_name === '$shopify_cart'
      && JSON.stringify(call[0]).includes(WIDGET_CART));
    expect(reportCall).toBeGreaterThanOrEqual(0);
    expect(enqueue.mock.invocationCallOrder[reportCall]).toBeLessThan(flush.mock.invocationCallOrder[0]);
  });

  test('cookie reports follow the stamping gates: off when the store turned cart attributes off or marketing is declined', async () => {
    mockNetwork({ waitForShopifyConsent: true });
    stubShopifyAnswers({ analyticsAllowed: true, marketingAllowed: true, visitor: { analytics: 'yes', marketing: 'yes' } });
    let sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, shopifyCartAttributes: false });
    let enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    document.cookie = `cart=${encodeURIComponent(`${WIDGET_CART}?key=${CART_KEY}`)}; path=/`;
    instance.track('add_to_cart');
    expect(cartReports(enqueue)).toHaveLength(0);
    instance.destroy();

    stubShopifyAnswers({ analyticsAllowed: true, marketingAllowed: false, visitor: { analytics: 'yes', marketing: 'no' } });
    sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, shopifyCartAttributes: true });
    enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    instance.track('add_to_cart');
    window.dispatchEvent(new Event('pagehide'));
    expect(cartReports(enqueue)).toHaveLength(0);
  });
});

describe('Shopify cart watch (1.7.21)', () => {
  const originalFetch = global.fetch;
  let instance: any;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    instance?.destroy();
    instance = undefined;
    global.fetch = originalFetch;
    delete (window as any).Shopify;
    delete (window as any).datalyr;
    document.cookie = 'cart=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    localStorage.clear();
    jest.restoreAllMocks();
  });

  const WIDGET_CART = 'Wdgt9Y6FdVrLgn7ZJ5mpqZ0iXy';
  const cartReports = (enqueue: jest.SpyInstance) => enqueue.mock.calls
    .map((call: any[]) => call[0]).filter((p: any) => p.event_name === '$shopify_cart');
  const updates = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter(([url]) => String(url).includes('/cart/update.js'));

  async function boot(opts: { marketing?: boolean } = {}): Promise<{ enqueue: jest.SpyInstance; fetchMock: jest.Mock }> {
    const fetchMock = mockNetwork({ waitForShopifyConsent: true });
    const marketing = opts.marketing !== false;
    stubShopifyAnswers({ analyticsAllowed: true, marketingAllowed: marketing, visitor: { analytics: 'yes', marketing: marketing ? 'yes' : 'no' } });
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, shopifyCartAttributes: true });
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    return { enqueue, fetchMock };
  }

  test('a cart created by a widget after page load is stamped and reported by the watch, once', async () => {
    const { enqueue, fetchMock } = await boot();
    expect(instance.shopifyCartWatchTimer).not.toBeNull();
    expect(updates(fetchMock)).toHaveLength(1);
    // The widget replaces the cart; no page load, no tracked event.
    document.cookie = `cart=${encodeURIComponent(`${WIDGET_CART}?key=${CART_KEY}`)}; path=/`;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/cart/update.js')) return { ok: true, status: 200, json: async () => ({ token: `${WIDGET_CART}?key=${CART_KEY}`, attributes: {} }) };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    instance.checkShopifyCart();
    await settle();
    expect(updates(fetchMock)).toHaveLength(2);
    const reports = cartReports(enqueue);
    expect(reports).toHaveLength(2);
    expect(JSON.stringify(reports[1])).toContain(WIDGET_CART);
    expect(JSON.stringify(reports[1])).not.toContain(CART_KEY);
    // The same cart on the next tick: nothing more.
    instance.checkShopifyCart();
    await settle();
    expect(updates(fetchMock)).toHaveLength(2);
    expect(cartReports(enqueue)).toHaveLength(2);
  });

  test('a cart the store will not let us stamp is not retried every tick', async () => {
    const { fetchMock } = await boot();
    document.cookie = `cart=${encodeURIComponent(`${WIDGET_CART}?key=${CART_KEY}`)}; path=/`;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/cart/update.js')) throw new Error('blocked by CSP');
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    instance.checkShopifyCart();
    await settle();
    const after = updates(fetchMock).length;
    instance.checkShopifyCart();
    instance.checkShopifyCart();
    await settle();
    expect(updates(fetchMock)).toHaveLength(after);
  });

  test('the watch respects the consent gate and stops on destroy', async () => {
    const { enqueue, fetchMock } = await boot({ marketing: false });
    expect(instance.shopifyCartWatchTimer).toBeNull();
    document.cookie = `cart=${encodeURIComponent(`${WIDGET_CART}?key=${CART_KEY}`)}; path=/`;
    instance.checkShopifyCart();
    await settle();
    expect(updates(fetchMock)).toHaveLength(0);
    expect(cartReports(enqueue)).toHaveLength(0);

    instance.destroy();
    expect(instance.shopifyCartWatchTimer).toBeNull();
    instance = undefined;
  });

  test('after a cart event the tag is re-read and restamped when a widget rewrote the attributes', async () => {
    const { fetchMock } = await boot();
    let cartAttributes: Record<string, string> = {};
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('/cart/update.js')) return { ok: true, status: 200, json: async () => ({ token: `${CART_ID}?key=${CART_KEY}`, attributes: {} }) };
      if (target.endsWith('/cart.js')) return { ok: true, status: 200, json: async () => ({ token: `${CART_ID}?key=${CART_KEY}`, attributes: cartAttributes }) };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    const before = updates(fetchMock).length;
    // The widget wiped our attributes (dainti: Shopify.actions.updateCart replaces them all).
    cartAttributes = { _dainti_upload_id: 'x' };
    instance.track('add_to_cart', { value: 25 });
    expect(instance.shopifyCartTagCheckTimer).not.toBeNull();
    await instance.verifyShopifyCartTag();
    await settle();
    expect(updates(fetchMock)).toHaveLength(before + 1);
    // Our tag intact: no write.
    cartAttributes = { _datalyr_visitor_id: instance.identity.getAnonymousId() };
    await instance.verifyShopifyCartTag();
    await settle();
    expect(updates(fetchMock)).toHaveLength(before + 1);
  });
});

describe('shopifyCartId', () => {
  test.each([
    [`${CART_ID}?key=${CART_KEY}`, CART_ID],
    [encodeURIComponent(`${CART_ID}?key=${CART_KEY}`), CART_ID],
    [CART_ID, CART_ID],
    ['  ' + CART_ID + '  ', CART_ID],
  ])('%s -> %s', (raw, expected) => {
    expect(shopifyCartId(raw)).toBe(expected);
  });

  test.each([[null], [undefined], [42], [''], ['short'], ['has space in it abcdefgh'], ['<script>alert(1)</script>xxxxxxxx']])(
    'rejects %p',
    (raw) => {
      expect(shopifyCartId(raw)).toBeNull();
    },
  );
});
