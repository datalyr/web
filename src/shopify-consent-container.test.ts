/**
 * On Shopify, tracking + marketing consent read false until the Customer
 * Privacy API loads, so the init-time container gate is closed. The container
 * (and its Meta pixel) must start once consent resolves to allowed, exactly
 * once, with the held landing pageview reaching the pixel exactly once.
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

/** Loads the SDK with encryption init held open until release() (identity hydration in flight). */
function loadSdkWithEncryptionHeld(): { sdk: SdkModule; release: () => void } {
  let sdk!: SdkModule;
  let release!: () => void;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const encryption = require('./encryption');
    const held = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(encryption.dataEncryption, 'initialize').mockImplementation(() => held);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return { sdk, release };
}

const PIXEL = '1045217738333459';

function mockNetwork(remoteConfig?: Record<string, unknown>): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/container-scripts')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          scripts: [],
          pixels: { meta: { enabled: true, pixel_id: PIXEL } },
          ...(remoteConfig ? { config: remoteConfig } : {}),
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Container initialisations (policy re-checks carry purpose: 'pixel_forwarding'). */
function containerInits(fetchMock: jest.Mock): number {
  return fetchMock.mock.calls.filter(([url, init]) =>
    String(url).includes('/container-scripts') && !JSON.parse(init.body).purpose,
  ).length;
}

/** PageView calls to the Meta pixel, whichever fbq method carried them. */
function pixelPageViews(fbq: jest.Mock): unknown[][] {
  return fbq.mock.calls.filter((call) =>
    (call[0] === 'track' && call[1] === 'PageView') || (call[0] === 'trackSingle' && call[2] === 'PageView'));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

const baseConfig = {
  workspaceId: 'ws-shopify-consent',
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

describe('Shopify consent resolving after init starts the container once', () => {
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
    delete (window as any).fbq;
    delete (window as any)._fbq;
    delete (window as any).datalyr;
    document.head.innerHTML = '';
    localStorage.clear();
    jest.restoreAllMocks();
  });

  test('consent granted later: one container init, autoConfig before init, one PageView with the pageview event id', async () => {
    const fetchMock = mockNetwork();
    const shopify = stubPendingShopify();
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();

    expect(containerInits(fetchMock)).toBe(0);
    expect(fbq).not.toHaveBeenCalled();
    const enqueue = jest.spyOn(instance.queue, 'enqueue');

    // Customer Privacy loads (with the retry path calling back twice) and the
    // banner fires its event too: all must converge on one container + pageview.
    shopify.resolve({ analytics: true, marketing: true });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();

    expect(containerInits(fetchMock)).toBe(1);
    const commands = fbq.mock.calls.map((call) => call[0] + ':' + call[1]);
    expect(commands.filter((c) => c === 'init:' + PIXEL)).toHaveLength(1);
    expect(commands.indexOf('set:autoConfig')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('set:autoConfig')).toBeLessThan(commands.indexOf('init:' + PIXEL));

    const pageviews = enqueue.mock.calls.map((call: any[]) => call[0]).filter((p: any) => p.event_name === 'pageview');
    expect(pageviews).toHaveLength(1);
    const pageViews = pixelPageViews(fbq);
    expect(pageViews).toHaveLength(1);
    expect(pageViews[0]).toEqual(['trackSingle', PIXEL, 'PageView', expect.any(Object), { eventID: pageviews[0].event_id }]);

    // A later consent event does not start a second container or re-send PageView.
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(containerInits(fetchMock)).toBe(1);
    expect(pixelPageViews(fbq)).toHaveLength(1);
  });

  test.each([
    ['marketing declined', { analytics: true, marketing: false }],
    ['analytics and marketing declined', { analytics: false, marketing: false }],
  ])('%s: nothing loads', async (_name, consent) => {
    const fetchMock = mockNetwork();
    const shopify = stubPendingShopify();
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();

    shopify.resolve(consent);
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();

    expect(containerInits(fetchMock)).toBe(0);
    expect(fbq).not.toHaveBeenCalled();
    expect(instance.container).toBeUndefined();
  });

  test('consent already known at init: the container starts at init and a later consent event does not re-create it', async () => {
    const fetchMock = mockNetwork();
    const shopify = stubPendingShopify();
    (window as any).Shopify.customerPrivacy = {
      analyticsProcessingAllowed: () => true,
      marketingAllowed: () => true,
    };
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();
    await settle();
    expect(containerInits(fetchMock)).toBe(1);

    shopify.resolve({ analytics: true, marketing: true });
    document.dispatchEvent(new Event('visitorConsentCollected'));
    await settle();
    expect(containerInits(fetchMock)).toBe(1);
    expect(fbq.mock.calls.filter((call) => call[0] === 'init')).toHaveLength(1);
    expect(pixelPageViews(fbq)).toHaveLength(1);
  });

  test('consent resolving before the init gate is picked up by init itself, once', async () => {
    const fetchMock = mockNetwork();
    (window as any).Shopify = {
      // Answers synchronously, inside init(), before initializeAsync reaches the gate.
      loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => {
        (window as any).Shopify.customerPrivacy = {
          analyticsProcessingAllowed: () => true,
          marketingAllowed: () => true,
        };
        callback();
      },
    };
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();
    await settle();

    expect(containerInits(fetchMock)).toBe(1);
    expect(fbq.mock.calls.filter((call) => call[0] === 'init')).toHaveLength(1);
    expect(pixelPageViews(fbq)).toHaveLength(1);
  });

  test.each([
    ['data-platform="shopify"', baseConfig],
    ['a plain snippet (no platform)', { ...baseConfig, platform: undefined }],
  ])('with the Shopify Facebook & Instagram app on the page, the late container stays in companion mode: %s', async (_name, sdkConfig) => {
    const fetchMock = mockNetwork();
    const shopify = stubPendingShopify();
    const config = document.createElement('script');
    config.text = 'var wpmLoader=function(){};wpmLoader({webPixelsConfigList: [{"id":"2046230576",'
      + '"configuration":"{\\"pixel_id\\":\\"' + PIXEL + '\\",\\"pixel_type\\":\\"facebook_pixel\\"}",'
      + '"runtimeContext":"OPEN","type":"APP","apiClientId":2329312}]});';
    document.head.appendChild(config);
    // The app's pixel already rendered (window.fbq with its init queued).
    const appFbq: any = jest.fn();
    appFbq.queue = [['init', PIXEL, {}, { agent: 'shopify_web_pixel' }]];
    (window as any).fbq = appFbq;

    instance = loadSdk().createDatalyrInstance();
    instance.init(sdkConfig);
    await instance.ready();
    shopify.resolve({ analytics: true, marketing: true });
    await settle();

    expect(containerInits(fetchMock)).toBe(1);
    expect(instance.container.isMetaCompanionMode()).toBe(true);
    expect(appFbq).not.toHaveBeenCalled(); // no autoConfig, no init, no PageView

    const enqueue = jest.spyOn(instance.queue, 'enqueue');
    instance.track('add_to_cart', { value: 25, currency: 'GBP' });
    await settle();
    const eventId = (enqueue.mock.calls[0][0] as any).event_id;
    expect(appFbq).toHaveBeenCalledTimes(1);
    expect(appFbq).toHaveBeenCalledWith('trackSingle', PIXEL, 'AddToCart', { value: 25, currency: 'GBP' }, { eventID: eventId });
  });

  test('a late container gets the dashboard config: privacyMode strict loads no pixel and forwards nothing', async () => {
    const fetchMock = mockNetwork({ privacyMode: 'strict' });
    const shopify = stubPendingShopify();
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    instance = loadSdk().createDatalyrInstance();
    instance.init(baseConfig);
    await instance.ready();

    shopify.resolve({ analytics: true, marketing: true });
    await settle();
    expect(containerInits(fetchMock)).toBe(1);
    expect(instance.config.privacyMode).toBe('strict');
    expect(fbq).not.toHaveBeenCalled();

    instance.track('add_to_cart', { value: 5 });
    await settle();
    expect(fbq).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes('/container-scripts') && JSON.parse(init.body).purpose === 'pixel_forwarding')).toBe(false);
  });

  test('a late container gets the dashboard config: respectDoNotTrack with DNT on loads no pixel and holds the pageview', async () => {
    const fetchMock = mockNetwork({ respectDoNotTrack: true });
    const shopify = stubPendingShopify();
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    (window as any).doNotTrack = '1';
    try {
      instance = loadSdk().createDatalyrInstance();
      instance.init(baseConfig);
      await instance.ready();
      const enqueue = jest.spyOn(instance.queue, 'enqueue');

      shopify.resolve({ analytics: true, marketing: true });
      await settle();
      expect(containerInits(fetchMock)).toBe(1);
      expect(instance.config.respectDoNotTrack).toBe(true);
      expect(fbq).not.toHaveBeenCalled();
      expect(enqueue.mock.calls.filter((call: any[]) => call[0].event_name === 'pageview')).toHaveLength(0);
    } finally {
      delete (window as any).doNotTrack;
    }
  });

  test('a grant arriving while init is still hydrating identity does not start the container early', async () => {
    const fetchMock = mockNetwork();
    const shopify = stubPendingShopify();
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    const { sdk, release } = loadSdkWithEncryptionHeld();
    instance = sdk.createDatalyrInstance();
    instance.init(baseConfig);

    // Consent resolves before initializeAsync reaches the container gate.
    shopify.resolve({ analytics: true, marketing: true });
    await settle();
    expect(containerInits(fetchMock)).toBe(0);
    expect(fbq).not.toHaveBeenCalled();

    release();
    await instance.ready();
    await settle();
    expect(containerInits(fetchMock)).toBe(1);
    expect(fbq.mock.calls.filter((call) => call[0] === 'init')).toHaveLength(1);
    expect(pixelPageViews(fbq)).toHaveLength(1);
  });
});
