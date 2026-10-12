/**
 * Through the whole SDK: on a Shopify store the AppLovin pixel waits for the
 * Customer Privacy API like every Container pixel (nothing before consent
 * resolves, nothing on a marketing decline). Page views never go through it;
 * a mapped event reaches it with dedupe_id = the event_id of the ingested copy,
 * the id the postback worker's AppLovin sender uses for every non-purchase event.
 */
import { createPixelsModule } from './pixels';

type SdkModule = typeof import('./index');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

const KEY = 'AxEvtKey_sdk';

function mockNetwork(): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/container-scripts')) {
      return { ok: true, status: 200, json: async () => ({ scripts: [], pixels: { applovin: { enabled: true, event_key: KEY, account_type: 'purchase', events: { pageview: 'page_view', product_added: 'add_to_cart', purchase: 'purchase' }, values: ['purchase'] } } }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function stubPendingShopify(): { resolve: (consent: { analytics: boolean; marketing: boolean }) => void } {
  const callbacks: Array<(error?: unknown) => void> = [];
  (window as any).Shopify = {
    loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => { callbacks.push(callback); },
  };
  return {
    resolve: ({ analytics, marketing }) => {
      (window as any).Shopify.customerPrivacy = {
        analyticsProcessingAllowed: () => analytics,
        marketingAllowed: () => marketing,
      };
      callbacks.forEach((callback) => callback());
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function axonCalls(): unknown[][] {
  const axon = (window as any).axon;
  return axon ? Array.from(axon.operationQueue as ArrayLike<ArrayLike<unknown>>).map((args) => Array.from(args)) : [];
}

const baseConfig = {
  workspaceId: 'ws-applovin-consent',
  platform: 'shopify' as const,
  enableFingerprinting: false,
  enablePerformanceTracking: false,
  trackPageViews: true,
  trackSPA: false,
  shopifyCartAttributes: false,
  stripePaymentLinks: false,
  stripeCheckoutSessions: false,
  inAppHandoff: false,
};

describe('AppLovin pixel behind Shopify consent', () => {
  const originalFetch = global.fetch;
  let instance: any;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    document.head.appendChild(document.createElement('script'));
    (window as any).DatalyrPixels = createPixelsModule(); // as dl.pixels.<v>.js registers it
  });

  afterEach(() => {
    instance?.destroy();
    instance = undefined;
    global.fetch = originalFetch;
    for (const key of ['Shopify', 'axon', 'AXON_EVENT_KEY', 'datalyr', 'DatalyrPixels', '__datalyrLandingPageView']) {
      try { delete (window as any)[key]; } catch { (window as any)[key] = undefined; }
    }
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    localStorage.clear();
    jest.restoreAllMocks();
  });

  test('nothing before consent; on consent one pixel; no page view through it; events carry the ingested event_id', async () => {
    mockNetwork();
    const shopify = stubPendingShopify();
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();
    await settle();
    expect((window as any).axon).toBeUndefined();
    const enqueue = jest.spyOn(instance.queue, 'enqueue');

    shopify.resolve({ analytics: true, marketing: true });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();

    expect((window as any).AXON_EVENT_KEY).toBe(KEY);
    const pageviews = enqueue.mock.calls.map((call: any[]) => call[0]).filter((p: any) => p.event_name === 'pageview');
    expect(pageviews).toHaveLength(1);
    // axon("init") sends no page view, so the Container sends the landing one,
    // with the ingested copy's event_id as dedupe_id.
    expect(axonCalls()).toEqual([['init'], ['track', 'page_view', {}, { dedupe_id: pageviews[0].event_id }]]);

    instance.track('product_added', { product_id: 'p1' });
    await settle();
    const added = enqueue.mock.calls.map((call: any[]) => call[0]).find((p: any) => p.event_name === 'product_added');
    expect(axonCalls()[2]).toEqual(['track', 'add_to_cart', expect.any(Object), { dedupe_id: added.event_id }]);

    // A super property is part of the server copy's event_data: the pixel
    // reads the currency from it too.
    instance.setSuperProperties({ currency: 'gbp' });
    // A purchase: the pixel's dedupe_id is the order id, which the ingested
    // copy carries in event_data.order_id.
    instance.track('purchase', { order_id: 'ORD-9', value: 25 });
    await settle();
    const purchase = enqueue.mock.calls.map((call: any[]) => call[0]).find((p: any) => p.event_name === 'purchase');
    expect(purchase.event_data.order_id).toBe('ORD-9');
    expect(axonCalls()[3]).toEqual(['track', 'purchase',
      expect.objectContaining({ transaction_id: 'ORD-9', currency: 'GBP', value: 25 }), { dedupe_id: 'ORD-9' }]);
    expect(purchase.event_data.currency).toBe('gbp'); // the server copy carries the same super property
  });

  test.each([
    ['a site without AppLovin', false, true],
    ['an AppLovin site whose pixels module never arrives', true, false],
    ['an AppLovin site whose pixel loads', true, true],
  ])('%s: the landing pageview is not held for the pixel, and carries no AppLovin stamp', async (_name, withAppLovin, moduleArrives) => {
    if (!moduleArrives) delete (window as any).DatalyrPixels;
    const fetchMock = mockNetwork();
    if (!withAppLovin) {
      fetchMock.mockImplementation(async (url: string) => (String(url).includes('/container-scripts')
        ? { ok: true, status: 200, json: async () => ({ scripts: [], pixels: {} }) }
        : { ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    }
    const shopify = stubPendingShopify();
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    shopify.resolve({ analytics: true, marketing: true });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    // Only zero-delay ticks: a hold of any length (a module fetch, a 2 s DOM
    // wait) would leave the pageview unsent here.
    await settle();
    const pageviews = enqueue.mock.calls.map((call: any[]) => call[0]).filter((p: any) => p.event_name === 'pageview');
    expect(pageviews).toHaveLength(1);
    expect(JSON.stringify(pageviews[0].event_data)).not.toMatch(/applovin/i);
  });

  test('marketing declined: the AppLovin pixel never loads', async () => {
    mockNetwork();
    const shopify = stubPendingShopify();
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();
    shopify.resolve({ analytics: true, marketing: false });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect((window as any).axon).toBeUndefined();
    expect(Array.from(document.querySelectorAll('script')).some((s) => s.src.includes('axon.ai'))).toBe(false);
  });
});
