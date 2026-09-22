import {
  ContainerManager,
  shopifyFacebookAppPixelRunning,
  shopifyPageConfiguresFacebookAppPixel,
} from './container';

const PIXEL = '1045217738333459';

// Trimmed from a real storefront's content_for_header: Shopify's inline
// web-pixels bootstrap. Each pixel's `configuration` is a JSON document
// serialized as a string inside the JS object literal.
function fbAppEntry(pixelId: string): string {
  return String.raw`{"id":"2046230576","configuration":"{\"pixel_id\":\"` + pixelId
    + String.raw`\",\"pixel_type\":\"facebook_pixel\"}","eventPayloadVersion":"v1","runtimeContext":"OPEN","scriptVersion":"96420dbe9ea96c426a1b7f364f977719","type":"APP","apiClientId":2329312,"privacyPurposes":["ANALYTICS","MARKETING","SALE_OF_DATA"]}`;
}
const OTHER_APP_ENTRY = String.raw`{"id":"2785902640","configuration":"{\"workspaceId\":\"4uC8H8OMn0\",\"ingestUrl\":\"https:\/\/ingest.datalyr.com\"}","eventPayloadVersion":"v1","runtimeContext":"STRICT","scriptVersion":"c13fc9e2d4a88a12e52f914500f62e6f","type":"APP","apiClientId":244540211201}`;
// Same pixel id, different pixel type: must not trigger companion mode.
const LOOKALIKE_ENTRY = String.raw`{"id":"1","configuration":"{\"pixel_id\":\"${PIXEL}\",\"pixel_type\":\"tiktok_pixel\"}","runtimeContext":"STRICT","type":"APP","apiClientId":1}`;

function addShopifyPixelsConfig(entries: string[]): void {
  const script = document.createElement('script');
  script.text = '(function(){var wpmLoader=function(){};wpmLoader({shopId: 70509658160,'
    + 'storefrontBaseUrl: "https://example.shop",surface: "storefront-renderer",'
    + 'enabledBetaFlags: ["0fa89373"],webPixelsConfigList: [' + entries.join(',') + '],'
    + 'isMerchantRequest: false,effectiveTopLevelDomain: ""});})();';
  document.head.appendChild(script);
}

/** Same shape as the stub the Facebook & Instagram app installs (its gt()). */
function installAppFbqStub(): any {
  const fbq: any = function (...args: unknown[]) {
    fbq.callMethod ? fbq.callMethod.apply(fbq, args) : fbq.queue.push(args);
  };
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.queue = [];
  (window as any).fbq = fbq;
  (window as any)._fbq = fbq;
  return fbq;
}

/** What the app's pixel does when Shopify renders it (set context, init, PageView). */
function appRendersPixel(fbq: any, pixelId = PIXEL): void {
  fbq('set', 'shopifySandboxContext', { pixelId, runtimeContext: 'OPEN' });
  fbq('init', pixelId, {}, { agent: 'shopify_web_pixel' });
  fbq('trackShopify', pixelId, 'PageView', {}, { eventID: 'shopify-event-1' }, {});
}

function mockPixels(meta: Record<string, unknown> = {}): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ scripts: [], pixels: { meta: { enabled: true, pixel_id: PIXEL, ...meta } } }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function fbeventsScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll('script')).filter((s) => s.src.includes('connect.facebook.net'));
}

function queuedCommands(fbq: any): unknown[][] {
  return fbq.queue.map((entry: ArrayLike<unknown>) => Array.prototype.slice.call(entry));
}

describe('Shopify Facebook & Instagram app detection', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as any).fbq;
    delete (window as any)._fbq;
  });

  test('page config: matches facebook_pixel with the same pixel id only', () => {
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(false);
    addShopifyPixelsConfig([OTHER_APP_ENTRY, LOOKALIKE_ENTRY, fbAppEntry('999')]);
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(false);
    expect(shopifyPageConfiguresFacebookAppPixel('999')).toBe(true);
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(true);
    expect(shopifyPageConfiguresFacebookAppPixel('')).toBe(false);
  });

  test('page config: external scripts are not read', () => {
    const external = document.createElement('script');
    external.src = 'https://cdn.example/wpm.js';
    external.text = 'webPixelsConfigList facebook_pixel "configuration":"{\\"pixel_id\\":\\"' + PIXEL + '\\",\\"pixel_type\\":\\"facebook_pixel\\"}"';
    document.head.appendChild(external);
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(false);
  });

  test('runtime: the app init (agent shopify_web_pixel) is recognised, a plain theme init is not', () => {
    const fbq = installAppFbqStub();
    fbq('init', PIXEL);
    expect(shopifyFacebookAppPixelRunning(fbq, PIXEL)).toBe(false);
    fbq('init', PIXEL, {}, { agent: 'shopify_web_pixel' });
    expect(shopifyFacebookAppPixelRunning(fbq, PIXEL)).toBe(true);
    expect(shopifyFacebookAppPixelRunning(fbq, '999')).toBe(false);
  });

  test('runtime: loaded fbevents state with the app agent is recognised', () => {
    const fbq: any = jest.fn();
    fbq.callMethod = jest.fn();
    fbq.queue = [];
    fbq.instance = { pixelsByID: { [PIXEL]: { agent: 'shopify_web_pixel' } } };
    expect(shopifyFacebookAppPixelRunning(fbq, PIXEL)).toBe(true);
    fbq.instance = { pixelsByID: { [PIXEL]: { agent: 'tmgoogletagmanager' } } };
    expect(shopifyFacebookAppPixelRunning(fbq, PIXEL)).toBe(false);
  });
});

describe('Meta companion mode on Shopify', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;

  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as any).fbq;
    delete (window as any)._fbq;
    jest.useRealTimers();
  });

  test('with the app config: no fbevents, no init, no PageView; other events mirror with our eventID', async () => {
    addShopifyPixelsConfig([OTHER_APP_ENTRY, fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(manager.isMetaCompanionMode()).toBe(true);
    expect(fbeventsScripts()).toHaveLength(0);
    expect((window as any).fbq).toBeUndefined();

    // The app's pixel renders after us.
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    const before = fbq.queue.length;

    expect(await manager.trackToPixels('pageview', { url: '/' }, 'pv-1')).toEqual([]);
    expect(await manager.trackToPixels('add_to_cart', { value: 25, currency: 'GBP' }, 'atc-1')).toEqual(['meta']);

    const ours = queuedCommands(fbq).slice(before);
    expect(ours).toEqual([
      ['trackSingle', PIXEL, 'AddToCart', { value: 25, currency: 'GBP' }, { eventID: 'atc-1' }],
    ]);
    // Only the app ever called init.
    expect(queuedCommands(fbq).filter((c) => c[0] === 'init')).toEqual([
      ['init', PIXEL, {}, { agent: 'shopify_web_pixel' }],
    ]);
    expect(queuedCommands(fbq).some((c) => c[0] === 'set' && c[1] === 'autoConfig')).toBe(false);
  });

  test('uses the workspace rule mapping; custom names use trackSingleCustom; a rule mapped to PageView is skipped', async () => {
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels({ event_mappings: { signup: 'CompleteRegistration', quiz_done: 'QuizDone', landing: 'PageView' } });
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    const before = fbq.queue.length;

    await manager.trackToPixels('signup', {}, 'e1');
    await manager.trackToPixels('quiz_done', { score: 3 }, 'e2');
    await manager.trackToPixels('landing', {}, 'e3');
    await manager.trackToPixels('purchase', { value: 9 }, 'e4');

    expect(queuedCommands(fbq).slice(before)).toEqual([
      ['trackSingle', PIXEL, 'CompleteRegistration', {}, { eventID: 'e1' }],
      ['trackSingleCustom', PIXEL, 'QuizDone', { score: 3 }, { eventID: 'e2' }],
      ['trackSingle', PIXEL, 'Purchase', { value: 9 }, { eventID: 'e4' }],
    ]);
  });

  test('without the app config the Shopify store keeps full behaviour (autoConfig off, init, PageView)', async () => {
    addShopifyPixelsConfig([OTHER_APP_ENTRY, fbAppEntry('999')]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(manager.isMetaCompanionMode()).toBe(false);
    expect(fbeventsScripts()).toHaveLength(1);
    const fbq = (window as any).fbq;
    expect(await manager.trackToPixels('pageview', {}, 'pv-1')).toEqual(['meta']);
    expect(queuedCommands(fbq)).toEqual([
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
      ['track', 'PageView', {}, { eventID: 'pv-1' }],
    ]);
  });

  test('the app config is ignored when the install is not platform shopify', async () => {
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(false);
    expect(fbeventsScripts()).toHaveLength(1);
  });

  test('load-order race: an event tracked before the app pixel exists waits, then goes out after its init', async () => {
    jest.useFakeTimers();
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(true);

    let result: string[] | undefined;
    const pending = manager.trackToPixels('view_content', { content_ids: ['8087288315952'] }, 'vc-1')
      .then((sent) => { result = sent; });
    await jest.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    expect((window as any).fbq).toBeUndefined(); // we never create the stub ourselves

    // Stub first, init not yet queued: still waiting (trackSingle would be dropped).
    const fbq = installAppFbqStub();
    await jest.advanceTimersByTimeAsync(500);
    expect(result).toBeUndefined();
    expect(fbq.queue).toHaveLength(0);

    appRendersPixel(fbq);
    await jest.advanceTimersByTimeAsync(250);
    await pending;
    expect(result).toEqual(['meta']);
    const commands = queuedCommands(fbq);
    const initAt = commands.findIndex((c) => c[0] === 'init');
    const oursAt = commands.findIndex((c) => c[0] === 'trackSingle');
    expect(initAt).toBeGreaterThanOrEqual(0);
    expect(oursAt).toBeGreaterThan(initAt);
    expect(commands[oursAt]).toEqual(['trackSingle', PIXEL, 'ViewContent', { content_ids: ['8087288315952'] }, { eventID: 'vc-1' }]);
  });

  test('once fbevents has loaded, readiness comes from its pixel state', async () => {
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    const fbq: any = jest.fn();
    fbq.callMethod = jest.fn();
    fbq.queue = [];
    fbq.instance = { pixelsByID: { [PIXEL]: { agent: 'shopify_web_pixel' } } };
    (window as any).fbq = fbq;
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(fbq).not.toHaveBeenCalled();
    expect(await manager.trackToPixels('add_to_cart', { value: 1 }, 'atc-2')).toEqual(['meta']);
    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith('trackSingle', PIXEL, 'AddToCart', { value: 1 }, { eventID: 'atc-2' });
  });

  test('bounded wait: when the app pixel never appears the browser copy is skipped', async () => {
    jest.useFakeTimers();
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    let result: string[] | undefined;
    const pending = manager.trackToPixels('add_to_cart', {}, 'atc-3').then((sent) => { result = sent; });
    await jest.advanceTimersByTimeAsync(9000);
    expect(result).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1500);
    await pending;
    expect(result).toEqual([]);
    expect((window as any).fbq).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cleanup (consent withdrawn) releases waiting events without sending', async () => {
    jest.useFakeTimers();
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    const pending = manager.trackToPixels('add_to_cart', {}, 'atc-4');
    await jest.advanceTimersByTimeAsync(250);
    manager.cleanupAllIframes();
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    expect(await pending).toEqual([]);
    expect(queuedCommands(fbq).some((c) => c[0] === 'trackSingle')).toBe(false);
  });

  test('runtime fallback: the app already initialized the pixel before the container ran', async () => {
    mockPixels();
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(true);
    expect(fbeventsScripts()).toHaveLength(0);
    expect(queuedCommands(fbq).filter((c) => c[0] === 'init')).toHaveLength(1);
  });

  test('a theme-coded init of the same pixel (no app) keeps full behaviour', async () => {
    mockPixels();
    const fbq = installAppFbqStub();
    fbq('init', PIXEL);
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(false);
    expect(queuedCommands(fbq).slice(1)).toEqual([
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
    ]);
  });

  test('HTML still parsing: the decision waits for DOMContentLoaded and sees the config', async () => {
    mockPixels();
    const readyState = jest.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    try {
      manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
      const initialized = manager.init();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
      readyState.mockReturnValue('interactive');
      document.dispatchEvent(new Event('DOMContentLoaded'));
      await initialized;
      expect(manager.isMetaCompanionMode()).toBe(true);
      expect(fbeventsScripts()).toHaveLength(0);
    } finally {
      readyState.mockRestore();
    }
  });
});

describe('Meta pixel initialized by the container', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;

  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as any).fbq;
    delete (window as any)._fbq;
  });

  test('autoConfig is disabled for the pixel before fbq init', async () => {
    mockPixels();
    const fbq: any = jest.fn();
    (window as any).fbq = fbq;
    manager = new ContainerManager({
      workspaceId: 'ws',
      getIdentity: () => ({ externalId: 'visitor-1' }),
    });
    await manager.init();

    const calls = fbq.mock.calls.map((c: unknown[]) => c.slice(0, 2).join(':'));
    expect(calls).toEqual(['set:autoConfig', 'init:' + PIXEL]);
    expect(fbq.mock.calls[0]).toEqual(['set', 'autoConfig', false, PIXEL]);
  });

  test('concurrent init() calls initialize the pixel once', async () => {
    const fetchMock = mockPixels();
    const fbq: any = jest.fn();
    (window as any).fbq = fbq;
    manager = new ContainerManager({ workspaceId: 'ws' });
    await Promise.all([manager.init(), manager.init()]);
    await manager.init();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fbq.mock.calls.filter((c: unknown[]) => c[0] === 'init')).toHaveLength(1);
  });

  test('an event tracked while init is in flight is forwarded once init completes', async () => {
    mockPixels();
    const fbq: any = jest.fn();
    (window as any).fbq = fbq;
    manager = new ContainerManager({ workspaceId: 'ws' });
    const initialized = manager.init();
    const forwarded = manager.trackToPixels('pageview', {}, 'pv-early');
    await initialized;
    expect(await forwarded).toEqual(['meta']);
    const order = fbq.mock.calls.map((c: unknown[]) => c[0]);
    expect(order).toEqual(['set', 'init', 'track']);
    expect(fbq).toHaveBeenLastCalledWith('track', 'PageView', {}, { eventID: 'pv-early' });
  });
});
