/**
 * view_item from dl.js on Shopify product pages (1.9.7).
 *
 * The Datalyr Web Pixel sends view_item only when Shopify runs it, which needs
 * analytics AND marketing consent. dl.js sends it when the pixel cannot run and
 * dl.js itself may track, and stays quiet everywhere else.
 */
export {}; // module scope: index.test.ts declares the same helper names globally

import { readShopifyProductView, readShopifySearch, shopifyPixelWillRun } from './shopify-product-view';

type SdkModule = typeof import('./index');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

function mockNetwork(policy: Record<string, unknown>): void {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('/sdk-consent-policy')) return { ok: true, status: 200, json: async () => policy };
    return { ok: true, status: 200, json: async () => ({ scripts: [], pixels: {} }), text: async () => '' };
  }) as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// The product page data Shopify inlines on dainti.shop/products/photo-necklace.
const PRODUCT_META = {
  page: { pageType: 'product', resourceType: 'product', resourceId: 8087288315952, requestId: 'req-1' },
  product: {
    id: 8087288315952,
    gid: 'gid://shopify/Product/8087288315952',
    vendor: 'dainti',
    type: 'Necklace',
    variants: [
      { id: 50624903118896, price: 3500, name: 'PHOTO PRINTED NECKLACE - Silver', public_title: 'Silver', sku: '' },
      { id: 50624903151664, price: 3900, name: 'PHOTO PRINTED NECKLACE - 18k Gold Plated', public_title: '18k Gold Plated', sku: 'GOLD-1' },
    ],
  },
};

function stubShopify(opts: {
  meta?: unknown;
  analyticsAllowed?: boolean;
  marketingAllowed?: boolean;
  visitor?: { analytics: string; marketing: string };
  loaded?: boolean;
}): void {
  const loaded = opts.loaded !== false;
  (window as any).ShopifyAnalytics = { meta: opts.meta === undefined ? PRODUCT_META : opts.meta };
  (window as any).Shopify = {
    currency: { active: 'USD', rate: '1.0' },
    loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => { if (loaded) callback(); },
    ...(loaded ? {
      customerPrivacy: {
        analyticsProcessingAllowed: () => opts.analyticsAllowed ?? false,
        marketingAllowed: () => opts.marketingAllowed ?? false,
        currentVisitorConsent: () => ({ ...(opts.visitor ?? { analytics: '', marketing: '' }), preferences: '', sale_of_data: '' }),
      },
    } : {}),
  };
}

const baseConfig = {
  workspaceId: 'ws-product-view',
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

function named(enqueue: jest.SpyInstance, name: string): any[] {
  return enqueue.mock.calls.map((call: any[]) => call[0]).filter((payload: any) => payload.event_name === name);
}

describe('dl.js view_item on Shopify product pages', () => {
  const originalFetch = global.fetch;
  let instance: any;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    window.history.replaceState({}, '', '/products/photo-necklace');
  });

  afterEach(() => {
    instance?.destroy();
    instance = undefined;
    global.fetch = originalFetch;
    delete (window as any).Shopify;
    delete (window as any).ShopifyAnalytics;
    delete (window as any).datalyr;
    localStorage.clear();
    jest.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  async function boot(config: Record<string, unknown> = baseConfig, waitMs = 20, holdMs = 0): Promise<jest.SpyInstance> {
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.shopifyConsentOverrideWaitMs = waitMs;
    instance.shopifyViewHoldMs = holdMs;
    instance.init(config);
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    return enqueue;
  }

  test('UK visitor with no answer, merchant does not wait: one view_item shaped like the pixel', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ analyticsAllowed: false, marketingAllowed: false });
    const enqueue = await boot();
    const views = named(enqueue, 'view_item');
    expect(named(enqueue, 'pageview')).toHaveLength(1);
    expect(views).toHaveLength(1);
    expect(views[0].event_data).toEqual(expect.objectContaining({
      product_id: '8087288315952',
      product_title: 'PHOTO PRINTED NECKLACE',
      variant_id: '50624903118896',
      variant_title: 'Silver',
      quantity: 1,
      unit_price: 35,
      line_value: null,
      price: 35,
      currency: 'USD',
      product_url: '/products/photo-necklace',
      categories: ['Necklace'],
      tracked_via: 'dl_storefront',
    }));
  });

  test('accepting the banner during the hold: the pixel reports the view, dl.js drops its copy', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot(baseConfig, 20, 60);
    expect(named(enqueue, 'view_item')).toHaveLength(0); // held
    (window as any).Shopify.customerPrivacy.analyticsProcessingAllowed = () => true;
    (window as any).Shopify.customerPrivacy.marketingAllowed = () => true;
    (window as any).Shopify.customerPrivacy.currentVisitorConsent = () => ({ analytics: 'yes', marketing: 'yes', preferences: '', sale_of_data: '' });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await new Promise((resolve) => setTimeout(resolve, 90));
    await settle();
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('no answer during the hold: sent when it ends', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot(baseConfig, 20, 60);
    expect(named(enqueue, 'view_item')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(named(enqueue, 'view_item')).toHaveLength(1);
  });

  test('leaving the page during the hold sends it at once, before the queue flush', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot(baseConfig, 20, 60_000);
    expect(named(enqueue, 'view_item')).toHaveLength(0);
    window.dispatchEvent(new Event('pagehide'));
    expect(named(enqueue, 'view_item')).toHaveLength(1);
  });

  test('the product form\'s variant (selected or first available) wins over the first variant', async () => {
    document.body.innerHTML = '<form action="/cart/add"><input type="hidden" name="id" value="50624903151664"></form>';
    try {
      mockNetwork({ waitForShopifyConsent: false });
      stubShopify({});
      const enqueue = await boot();
      expect(named(enqueue, 'view_item')[0].event_data.variant_id).toBe('50624903151664');
    } finally {
      document.body.innerHTML = '';
    }
  });

  test('the ?variant= in the URL picks the variant', async () => {
    window.history.replaceState({}, '', '/products/photo-necklace?variant=50624903151664');
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot();
    const [view] = named(enqueue, 'view_item');
    expect(view.event_data).toEqual(expect.objectContaining({ variant_id: '50624903151664', price: 39, sku: 'GOLD-1' }));
  });

  test('the pixel runs (analytics and marketing allowed): no view_item from dl.js', async () => {
    mockNetwork({ waitForShopifyConsent: true });
    stubShopify({ analyticsAllowed: true, marketingAllowed: true, visitor: { analytics: 'yes', marketing: 'yes' } });
    const enqueue = await boot();
    expect(named(enqueue, 'pageview')).toHaveLength(1);
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('an explicit decline: nothing at all', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ visitor: { analytics: 'no', marketing: 'no' } });
    const enqueue = await boot();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('analytics allowed, marketing declined: view_item sent, its consent says marketing false', async () => {
    mockNetwork({ waitForShopifyConsent: true });
    stubShopify({ analyticsAllowed: true, marketingAllowed: false, visitor: { analytics: 'yes', marketing: 'no' } });
    const enqueue = await boot();
    const views = named(enqueue, 'view_item');
    expect(views).toHaveLength(1);
    expect(views[0].event_data.consent).toEqual(expect.objectContaining({ marketing: false }));
  });

  test('default store (waits for consent), no answer: nothing, as before', async () => {
    mockNetwork({ waitForShopifyConsent: true });
    stubShopify({ analyticsAllowed: false, marketingAllowed: false });
    const enqueue = await boot();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('the Customer Privacy API never loads: no view_item (the pixel might still run)', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ loaded: false });
    const enqueue = await boot(baseConfig, 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();
    expect(named(enqueue, 'pageview')).toHaveLength(1);
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('once per page load: later consent changes and variant switches send no second view_item', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot();
    document.dispatchEvent(new Event('visitorConsentCollected'));
    window.history.replaceState({}, '', '/products/photo-necklace?variant=50624903151664');
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(named(enqueue, 'view_item')).toHaveLength(1);
  });

  test('not a product page: nothing', async () => {
    window.history.replaceState({}, '', '/collections/all');
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ meta: { page: { pageType: 'collection' } } });
    const enqueue = await boot();
    expect(named(enqueue, 'pageview')).toHaveLength(1);
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('shopifyAutoViewItem: false turns it off', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot({ ...baseConfig, shopifyAutoViewItem: false });
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('the page already sent its own view_item: no automatic one', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ loaded: false });
    const enqueue = await boot();
    instance.track('view_item', { product_id: 'own' });
    const shopify = (window as any).Shopify;
    shopify.customerPrivacy = {
      analyticsProcessingAllowed: () => false,
      marketingAllowed: () => false,
      currentVisitorConsent: () => ({ analytics: '', marketing: '', preferences: '', sale_of_data: '' }),
    };
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    const views = named(enqueue, 'view_item');
    expect(views).toHaveLength(1);
    expect(views[0].event_data.product_id).toBe('own');
  });

  test('the Customer Privacy API answers late (after the policy and the wait): one view_item then', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ loaded: false });
    const enqueue = await boot(baseConfig, 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();
    expect(named(enqueue, 'pageview')).toHaveLength(1);
    expect(named(enqueue, 'view_item')).toHaveLength(0);
    (window as any).Shopify.customerPrivacy = {
      analyticsProcessingAllowed: () => false,
      marketingAllowed: () => false,
      currentVisitorConsent: () => ({ analytics: '', marketing: '', preferences: '', sale_of_data: '' }),
    };
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(named(enqueue, 'view_item')).toHaveLength(1);
  });

  test('UK market prices: price and currency as Shopify inlines them (same as the pixel)', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    const gbMeta = { ...PRODUCT_META, product: { ...PRODUCT_META.product, variants: PRODUCT_META.product.variants.map((v) => ({ ...v, price: 2500 })) } };
    stubShopify({ meta: gbMeta });
    const enqueue = await boot();
    const [view] = named(enqueue, 'view_item');
    expect(view.event_data).toEqual(expect.objectContaining({ price: 25, unit_price: 25, currency: 'USD' }));
  });

  test('trackPageViews: false still sends the product view', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot({ ...baseConfig, trackPageViews: false });
    expect(named(enqueue, 'pageview')).toHaveLength(0);
    expect(named(enqueue, 'view_item')).toHaveLength(1);
  });

  test('the theme editor (Shopify.designMode): nothing', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    (window as any).Shopify.designMode = true;
    const enqueue = await boot();
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('Global Privacy Control respected: nothing', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true });
    try {
      const enqueue = await boot({ ...baseConfig, respectGlobalPrivacyControl: true });
      expect(named(enqueue, 'view_item')).toHaveLength(0);
    } finally {
      delete (navigator as any).globalPrivacyControl;
    }
  });

  const SEARCH_META = {
    page: { pageType: 'searchresults', requestId: 'req-s' },
    products: [{ id: 8087288315952, variants: [{ id: 1 }, { id: 2 }] }, { id: 8087288315999, variants: [{ id: 3 }] }],
  };

  test('search results page, pixel will not run: one search like the pixel (query + products on the page)', async () => {
    window.history.replaceState({}, '', '/search?q=necklace');
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ meta: SEARCH_META });
    const enqueue = await boot();
    const searches = named(enqueue, 'search');
    expect(searches).toHaveLength(1);
    expect(searches[0].event_data).toEqual(expect.objectContaining({ query: 'necklace', results_count: 2, tracked_via: 'dl_storefront' }));
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });

  test('a product page sends no search', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({});
    const enqueue = await boot();
    expect(named(enqueue, 'search')).toHaveLength(0);
  });

  test('search with trackPageViews: false', async () => {
    window.history.replaceState({}, '', '/search?q=necklace');
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ meta: SEARCH_META });
    const enqueue = await boot({ ...baseConfig, trackPageViews: false });
    expect(named(enqueue, 'search')).toHaveLength(1);
  });

  test('search results page, pixel runs: no search from dl.js', async () => {
    window.history.replaceState({}, '', '/search?q=necklace');
    mockNetwork({ waitForShopifyConsent: true });
    stubShopify({ meta: SEARCH_META, analyticsAllowed: true, marketingAllowed: true, visitor: { analytics: 'yes', marketing: 'yes' } });
    const enqueue = await boot();
    expect(named(enqueue, 'search')).toHaveLength(0);
  });

  test('search results page, explicit decline: nothing', async () => {
    window.history.replaceState({}, '', '/search?q=necklace');
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ meta: SEARCH_META, visitor: { analytics: 'no', marketing: 'no' } });
    const enqueue = await boot();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('the page already sent its own search: no automatic one', async () => {
    window.history.replaceState({}, '', '/search?q=necklace');
    mockNetwork({ waitForShopifyConsent: false });
    stubShopify({ meta: SEARCH_META, loaded: false });
    const enqueue = await boot();
    instance.track('search', { query: 'own' });
    (window as any).Shopify.customerPrivacy = {
      analyticsProcessingAllowed: () => false,
      marketingAllowed: () => false,
      currentVisitorConsent: () => ({ analytics: '', marketing: '', preferences: '', sale_of_data: '' }),
    };
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    const searches = named(enqueue, 'search');
    expect(searches).toHaveLength(1);
    expect(searches[0].event_data.query).toBe('own');
  });

  test('not a Shopify storefront: nothing', async () => {
    mockNetwork({ waitForShopifyConsent: false });
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init({ ...baseConfig, platform: 'generic' });
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    expect(named(enqueue, 'view_item')).toHaveLength(0);
  });
});

describe('shopifyPixelWillRun', () => {
  test.each([
    [{ analyticsProcessingAllowed: () => true, marketingAllowed: () => true }, true],
    [{ analyticsProcessingAllowed: () => true, marketingAllowed: () => false }, false],
    [{ analyticsProcessingAllowed: () => false, marketingAllowed: () => true }, false],
    [{}, null],
    [null, null],
    [{ analyticsProcessingAllowed: () => { throw new Error('x'); }, marketingAllowed: () => true }, null],
  ])('%#', (cp, expected) => {
    expect(shopifyPixelWillRun(cp)).toBe(expected);
  });
});

describe('readShopifyProductView', () => {
  test('falls back to og:title and window.meta, and reads og:image', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.head.innerHTML = '<meta property="og:title" content="Photo Necklace"><meta property="og:image" content="//dainti.shop/cdn/a.png">';
    const view = readShopifyProductView({
      location: { pathname: '/products/photo-necklace', search: '' },
      meta: { product: { id: 1, variants: [{ id: 2, price: 1000 }] }, currency: 'GBP' },
    }, doc);
    expect(view).toEqual(expect.objectContaining({
      product_id: '1', product_title: 'Photo Necklace', variant_id: '2', price: 10, currency: 'GBP',
      image_url: 'https://dainti.shop/cdn/a.png',
    }));
  });

  test('no product data: null', () => {
    expect(readShopifyProductView({ location: { pathname: '/', search: '' } }, document)).toBeNull();
    expect(readShopifyProductView({ ShopifyAnalytics: { meta: { page: { pageType: 'home' } } } }, document)).toBeNull();
  });
});

describe('readShopifySearch', () => {
  test('no query or not a search page: null', () => {
    expect(readShopifySearch({ location: { search: '' }, meta: { page: { pageType: 'searchresults' }, products: [] } })).toBeNull();
    expect(readShopifySearch({ location: { search: '?q=x' }, meta: { page: { pageType: 'product' } } })).toBeNull();
  });

  test('no results: results_count 0', () => {
    expect(readShopifySearch({ location: { search: '?q=zzz' }, meta: { page: { pageType: 'searchresults' }, products: [] } }))
      .toEqual({ query: 'zzz', results_count: 0, tracked_via: 'dl_storefront' });
  });
});
