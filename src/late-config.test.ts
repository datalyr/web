/**
 * Settings that used to reach the SDK only with the container (1.9.8).
 *
 * 1. A merchant who turned off honoring GPC / DNT in the dashboard: dl.js asks
 *    /sdk-consent-policy before consent, but only for a visitor GPC / DNT holds.
 * 2. Auto-identify: on Shopify the container, and so the dashboard's
 *    autoIdentify, arrives after consent — after init decided not to start it.
 */
export {}; // module scope: index.test.ts declares the same helper names globally

type SdkModule = typeof import('./index');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

function mockNetwork(policy: Record<string, unknown> | null, remoteConfig: Record<string, unknown> = {}): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/sdk-consent-policy')) {
      if (policy === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => policy };
    }
    if (target.includes('/container-scripts')) {
      return { ok: true, status: 200, json: async () => ({ scripts: [], pixels: {}, config: remoteConfig }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const baseConfig = {
  workspaceId: 'ws-late-config',
  enableFingerprinting: false,
  enablePerformanceTracking: false,
  enableContainer: false,
  trackPageViews: true,
  trackSPA: false,
  stripePaymentLinks: false,
  stripeCheckoutSessions: false,
  inAppHandoff: false,
};

function names(enqueue: jest.SpyInstance): string[] {
  return enqueue.mock.calls.map((call: any[]) => call[0].event_name);
}

function policyCalls(fetchMock: jest.Mock): any[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/sdk-consent-policy'));
}

describe('GPC / DNT turned off by the merchant', () => {
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
    delete (navigator as any).globalPrivacyControl;
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
    delete (window as any).datalyr;
    localStorage.clear();
    jest.restoreAllMocks();
  });

  async function boot(config: Record<string, unknown> = baseConfig): Promise<jest.SpyInstance> {
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init(config);
    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    await instance.ready();
    await settle();
    return enqueue;
  }

  test('GPC visitor, merchant turned GPC off: the landing pageview is sent and the id persists', async () => {
    (navigator as any).globalPrivacyControl = true;
    const fetchMock = mockNetwork({ waitForShopifyConsent: true, respectGlobalPrivacyControl: false });
    const enqueue = await boot();
    expect(names(enqueue)).toEqual(['pageview']);
    const [url, init] = policyCalls(fetchMock)[0];
    expect(String(url)).toBe('https://ingest.datalyr.com/sdk-consent-policy?ws=ws-late-config');
    expect(init).toEqual({ method: 'GET', credentials: 'omit' });
    expect(localStorage.getItem('dl_anonymous_id') || document.cookie).toBeTruthy();
  });

  test('GPC visitor, merchant still honors GPC (or no answer): nothing', async () => {
    (navigator as any).globalPrivacyControl = true;
    mockNetwork({ waitForShopifyConsent: true });
    let enqueue = await boot();
    expect(enqueue).not.toHaveBeenCalled();
    instance.destroy();
    mockNetwork(null);
    enqueue = await boot();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('DNT visitor, merchant turned DNT off: released; GPC still honored', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' });
    mockNetwork({ waitForShopifyConsent: true, respectDoNotTrack: false });
    const enqueue = await boot({ ...baseConfig, respectDoNotTrack: undefined });
    expect(names(enqueue)).toEqual(['pageview']);
  });

  test('a GPC answer does not release a visitor who is also held by DNT', async () => {
    (navigator as any).globalPrivacyControl = true;
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' });
    mockNetwork({ waitForShopifyConsent: true, respectGlobalPrivacyControl: false });
    const enqueue = await boot({ ...baseConfig, respectDoNotTrack: true });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('the snippet sets respectGlobalPrivacyControl: true — the snippet wins, nothing is asked', async () => {
    (navigator as any).globalPrivacyControl = true;
    const fetchMock = mockNetwork({ waitForShopifyConsent: true, respectGlobalPrivacyControl: false });
    const enqueue = await boot({ ...baseConfig, respectGlobalPrivacyControl: true });
    expect(policyCalls(fetchMock)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('an opted-out visitor stays out even when the merchant turned GPC off', async () => {
    (navigator as any).globalPrivacyControl = true;
    document.cookie = '__dl_opt_out=true; path=/';
    try {
      mockNetwork({ waitForShopifyConsent: true, respectGlobalPrivacyControl: false });
      const enqueue = await boot();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      document.cookie = '__dl_opt_out=; path=/; max-age=0';
    }
  });

  test('a visitor with neither GPC nor DNT on a plain site: no policy request', async () => {
    const fetchMock = mockNetwork({ waitForShopifyConsent: true });
    const enqueue = await boot();
    expect(policyCalls(fetchMock)).toHaveLength(0);
    expect(names(enqueue)).toEqual(['pageview']);
  });
});

describe('auto-identify from a container that starts after consent (Shopify)', () => {
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
    localStorage.clear();
    jest.restoreAllMocks();
  });

  function stubShopify(loaded: boolean): void {
    (window as any).Shopify = {
      loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => { if (loaded) callback(); },
      ...(loaded ? {
        customerPrivacy: {
          analyticsProcessingAllowed: () => true,
          marketingAllowed: () => true,
          currentVisitorConsent: () => ({ analytics: 'yes', marketing: 'yes', preferences: '', sale_of_data: '' }),
        },
      } : {}),
    };
  }

  const shopifyConfig = { ...baseConfig, platform: 'shopify' as const, enableContainer: true, shopifyCartAttributes: false };

  test('consent arrives after init: the dashboard autoIdentify starts email capture', async () => {
    mockNetwork({ waitForShopifyConsent: true }, { autoIdentify: true, autoIdentifyForms: true });
    stubShopify(false);
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init(shopifyConfig);
    await instance.ready();
    await settle();
    expect(instance.autoIdentify).toBeUndefined(); // still waiting for consent
    stubShopify(true);
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(instance.autoIdentify).toBeDefined();
  });

  test('dashboard autoIdentify false: not started', async () => {
    mockNetwork({ waitForShopifyConsent: true }, { autoIdentify: false });
    stubShopify(false);
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init(shopifyConfig);
    await instance.ready();
    await settle();
    stubShopify(true);
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(instance.autoIdentify).toBeUndefined();
  });

  test('marketing declined: not started', async () => {
    mockNetwork({ waitForShopifyConsent: true }, { autoIdentify: true });
    stubShopify(false);
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init(shopifyConfig);
    await instance.ready();
    await settle();
    (window as any).Shopify = {
      loadFeatures: (_f: unknown, cb: () => void) => cb(),
      customerPrivacy: {
        analyticsProcessingAllowed: () => true,
        marketingAllowed: () => false,
        currentVisitorConsent: () => ({ analytics: 'yes', marketing: 'no', preferences: '', sale_of_data: '' }),
      },
    };
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(instance.autoIdentify).toBeUndefined();
  });

  test('withdrawn on this page: not restarted by a later grant', async () => {
    mockNetwork({ waitForShopifyConsent: true }, { autoIdentify: true });
    stubShopify(true);
    const sdk = loadSdk();
    instance = sdk.createDatalyrInstance();
    instance.init(shopifyConfig);
    await instance.ready();
    await settle();
    expect(instance.autoIdentify).toBeDefined();
    instance.setConsent({ analytics: false });
    expect(instance.autoIdentify).toBeUndefined();
    instance.setConsent({ analytics: true });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(instance.autoIdentify).toBeUndefined();
  });
});
