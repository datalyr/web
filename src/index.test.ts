type SdkModule = typeof import('./index');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

describe('Datalyr instance factory and global singleton', () => {
  beforeEach(() => {
    delete (window as any).datalyr;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  it('preserves an existing window singleton when the module loads', () => {
    const existing = { marker: 'existing-sdk' };
    (window as any).datalyr = existing;

    const sdk = loadSdk();

    expect(sdk.datalyr).toBe(existing);
    expect((window as any).datalyr).toBe(existing);
  });

  it('creates and publishes the default singleton when none exists', () => {
    const sdk = loadSdk();

    expect((window as any).datalyr).toBe(sdk.datalyr);
    expect(sdk.datalyr.getWorkspaceId()).toBeNull();
  });

  it('creates independent instances without mutating window.datalyr', () => {
    const sdk = loadSdk();
    const singleton = (window as any).datalyr;

    const independent = sdk.createDatalyrInstance();

    expect(independent).not.toBe(sdk.datalyr);
    expect(independent.getWorkspaceId()).toBeNull();
    expect((window as any).datalyr).toBe(singleton);
  });

  it('reports the workspace configured by init()', async () => {
    const sdk = loadSdk();
    const independent = sdk.createDatalyrInstance();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    independent.init({
      workspaceId: 'workspace-factory-test',
      enableContainer: false,
      enableFingerprinting: false,
      enablePerformanceTracking: false,
      trackPageViews: false,
      trackSPA: false,
      stripePaymentLinks: false,
    });
    await independent.ready();

    expect(independent.getWorkspaceId()).toBe('workspace-factory-test');
    independent.destroy();
  });

  it('releases one pending Shopify pageview after async analytics consent loads', async () => {
    const sdk = loadSdk();
    const independent = sdk.createDatalyrInstance();
    const pageSpy = jest.spyOn(independent, 'page');
    let consentReady: ((error?: unknown) => void) | undefined;

    (window as any).Shopify = {
      loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => {
        consentReady = callback;
      },
    };

    independent.init({
      workspaceId: 'workspace-shopify-consent-test',
      platform: 'shopify',
      enableContainer: false,
      enableFingerprinting: false,
      enablePerformanceTracking: false,
      trackPageViews: true,
      trackSPA: false,
      shopifyCartAttributes: false,
      stripePaymentLinks: false,
    });
    await independent.ready();

    expect(pageSpy).not.toHaveBeenCalled();

    (window as any).Shopify.customerPrivacy = {
      analyticsProcessingAllowed: () => true,
      marketingAllowed: () => false,
    };
    consentReady?.();
    consentReady?.();

    expect(pageSpy).toHaveBeenCalledTimes(1);
    independent.destroy();
    delete (window as any).Shopify;
  });
});

// D02 — both privacy purges must invalidate the identity, not only delete the keys
// at rest: an encrypted hydration started by init() is still in flight when the
// visitor opts out, and without the generation bump it restores their email a tick
// after the purge (and re-persists it on the next page load).
describe('D02 — optOut() / setConsent() invalidate the in-flight identity', () => {
  const baseConfig = {
    enableContainer: false,
    enableFingerprinting: false,
    enablePerformanceTracking: false,
    trackPageViews: false,
    trackSPA: false,
    stripePaymentLinks: false,
  };

  const clearState = () => {
    localStorage.clear();
    // The opt-out cookie outlives the instance: a leftover one would make the
    // next case start opted out, so identify() would never set a user at all.
    document.cookie = '__dl_opt_out=; path=/; max-age=0';
    document.cookie = '__dl_visitor_id=; path=/; max-age=0';
    delete (window as any).datalyr;
  };

  beforeEach(clearState);

  afterEach(() => {
    clearState();
    jest.restoreAllMocks();
  });

  it.each([
    ['optOut', (sdk: any) => sdk.optOut()],
    ['setConsent({ analytics: false })', (sdk: any) => sdk.setConsent({ analytics: false })],
  ])('%s clears the user and bumps the identity generation', async (_name, purge) => {
    const sdk = loadSdk();
    const instance = sdk.createDatalyrInstance();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    instance.init({ workspaceId: 'workspace-d02', ...baseConfig });
    await instance.ready();

    instance.identify('alice@buyer.io');
    const identity = (instance as any).identity;
    expect(identity.getUserId()).toBe('alice@buyer.io');
    const generation = identity.getIdentityGeneration();

    purge(instance);

    expect(identity.getUserId()).toBeNull();
    expect(identity.getIdentityGeneration()).not.toBe(generation);
    expect(localStorage.getItem('dl_user_id')).toBeNull();
    expect(localStorage.getItem('dl_user_id_pii')).toBeNull();
    instance.destroy();
  });
});

describe('Checkout Champ pixel guard follows actual SDK forwarding', () => {
  afterEach(() => { window.sessionStorage.clear(); });
  test('a withheld pixel can retry and a successful Meta call records the order', async () => {
    const instance: any = loadSdk().createDatalyrInstance();
    const forward = jest.fn().mockResolvedValueOnce([]).mockResolvedValue(['meta']);
    instance.container = { hasMetaPixel: () => true, trackToPixels: forward };
    window.sessionStorage.setItem('orderData', JSON.stringify({ orderId: 'order-policy', totalAmount: 12, currency: 'USD' }));
    await instance.fireCheckoutChampPurchasePixel();
    expect(window.sessionStorage.getItem('__dl_cc_purchase_order-policy')).toBeNull();
    await instance.fireCheckoutChampPurchasePixel();
    expect(window.sessionStorage.getItem('__dl_cc_purchase_order-policy')).toBe('1');
    await instance.fireCheckoutChampPurchasePixel();
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenLastCalledWith('purchase', expect.objectContaining({ value: 12, currency: 'USD' }), 'checkoutchamp_purchase_order-policy');
  });
  test('overlapping calls do not forward the same order twice', async () => {
    const instance: any = loadSdk().createDatalyrInstance();
    let release!: (sent: string[]) => void;
    const forward = jest.fn(() => new Promise(resolve => { release = resolve; }));
    instance.container = { hasMetaPixel: () => true, trackToPixels: forward };
    window.sessionStorage.setItem('orderData', JSON.stringify({ orderId: 'order-race' }));
    const first = instance.fireCheckoutChampPurchasePixel();
    await instance.fireCheckoutChampPurchasePixel();
    expect(forward).toHaveBeenCalledTimes(1);
    release(['meta']);
    await first;
    expect(window.sessionStorage.getItem('__dl_cc_purchase_order-race')).toBe('1');
  });
});
