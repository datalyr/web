import {
  ContainerManager,
  readShopifyWebPixelsConfig,
  shopifyFacebookAppPixelRunning,
  shopifyPageConfiguresFacebookAppPixel,
  shopifyPageConfiguresGoogleAppTag,
  shopifyPageConfiguresTikTokAppPixel,
} from './container';

const PIXEL = '1045217738333459';
const GOOGLE_TAG = 'G-WSYJCRME4P';
const TIKTOK_CODE = 'DAN3HEJC77U719D2B0H0';

// Entries trimmed from real storefronts' content_for_header (Shopify's inline
// web-pixels bootstrap). Each `configuration` is a JSON document serialized as
// a string inside the JS object literal; the Google app nests one more level.
function fbAppEntry(pixelId: string): string {
  return String.raw`{"id":"2046230576","configuration":"{\"pixel_id\":\"` + pixelId
    + String.raw`\",\"pixel_type\":\"facebook_pixel\"}","eventPayloadVersion":"v1","runtimeContext":"OPEN","scriptVersion":"96420dbe9ea96c426a1b7f364f977719","type":"APP","apiClientId":2329312,"privacyPurposes":["ANALYTICS","MARKETING","SALE_OF_DATA"]}`;
}
function googleAppEntry(tagIds: string[]): string {
  const ids = tagIds.map((id) => String.raw`\\\"` + id + String.raw`\\\"`).join(',');
  return String.raw`{"id":"299434074","configuration":"{\"config\":\"{\\\"google_tag_ids\\\":[` + ids
    + String.raw`],\\\"target_country\\\":\\\"US\\\",\\\"gtag_events\\\":[{\\\"type\\\":\\\"page_view\\\",\\\"action_label\\\":\\\"G-WSYJCRME4P\\\"}],\\\"enable_monitoring_mode\\\":false}\"}","eventPayloadVersion":"v1","runtimeContext":"OPEN","scriptVersion":"a3321ca85cf5aaf6b57585fcd8d67b3a","type":"APP","apiClientId":1780363,"privacyPurposes":[]}`;
}
function tiktokAppEntry(code: string, apiClientId = 4383523): string {
  return String.raw`{"id":"2776596528","configuration":"{\"pixelCode\":\"` + code
    + String.raw`\"}","eventPayloadVersion":"v1","runtimeContext":"STRICT","scriptVersion":"22e92c2ad45662f435e4801458fb78cc","type":"APP","apiClientId":` + apiClientId + '}';
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

/** What the Google & YouTube app does in the page (its OPEN pixel source). */
function googleAppConfiguresTag(tagId = GOOGLE_TAG): any[] {
  const dataLayer: any[] = (window as any).dataLayer = (window as any).dataLayer || [];
  // eslint-disable-next-line prefer-rest-params
  const gtag = (window as any).gtag = (window as any).gtag || function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', tagId, { send_page_view: false });
  return dataLayer;
}

function mockConfig(pixels: Record<string, unknown>, config?: Record<string, unknown>): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ scripts: [], pixels, ...(config ? { config } : {}) }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockPixels(meta: Record<string, unknown> = {}): jest.Mock {
  return mockConfig({ meta: { enabled: true, pixel_id: PIXEL, ...meta } });
}

function scriptsFrom(host: string): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll('script')).filter((s) => s.src.includes(host));
}
const fbeventsScripts = () => scriptsFrom('connect.facebook.net');

function queuedCommands(queue: ArrayLike<unknown>[]): unknown[][] {
  return Array.from(queue).map((entry) => Array.prototype.slice.call(entry));
}

function resetPage(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const key of ['fbq', '_fbq', 'gtag', 'dataLayer', 'ttq', 'TiktokAnalyticsObject', 'Shopify', 'google_tag_manager']) {
    delete (window as any)[key];
  }
}

describe('Shopify app pixel detection', () => {
  afterEach(resetPage);

  test('reads apiClientId, runtime and the parsed configuration of each web pixel', () => {
    addShopifyPixelsConfig([OTHER_APP_ENTRY, tiktokAppEntry(TIKTOK_CODE), fbAppEntry(PIXEL), googleAppEntry([GOOGLE_TAG, 'AW-727142071'])]);
    const entries = readShopifyWebPixelsConfig();
    expect(entries.map((e) => [e.apiClientId, e.runtimeContext])).toEqual([
      [244540211201, 'STRICT'], [4383523, 'STRICT'], [2329312, 'OPEN'], [1780363, 'OPEN'],
    ]);
    expect(entries[1].configuration).toEqual({ pixelCode: TIKTOK_CODE });
    expect(JSON.parse(entries[3].configuration.config).google_tag_ids).toEqual([GOOGLE_TAG, 'AW-727142071']);
  });

  test('Meta: facebook_pixel with the same pixel id only', () => {
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(false);
    addShopifyPixelsConfig([OTHER_APP_ENTRY, LOOKALIKE_ENTRY, fbAppEntry('999')]);
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(false);
    expect(shopifyPageConfiguresFacebookAppPixel('999')).toBe(true);
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(true);
    expect(shopifyPageConfiguresFacebookAppPixel('')).toBe(false);
  });

  test('Google & YouTube: our tag id among google_tag_ids (or the legacy pixel_id) of apiClientId 1780363', () => {
    addShopifyPixelsConfig([googleAppEntry(['G-OTHER', 'AW-727142071'])]);
    expect(shopifyPageConfiguresGoogleAppTag(GOOGLE_TAG)).toBe(false);
    expect(shopifyPageConfiguresGoogleAppTag('AW-727142071')).toBe(true);
    const legacy = String.raw`{"id":"1","configuration":"{\"config\":\"{\\\"pixel_id\\\":\\\"G-LEGACY\\\",\\\"gtag_events\\\":[]}\"}","runtimeContext":"OPEN","type":"APP","apiClientId":1780363}`;
    const otherApp = googleAppEntry([GOOGLE_TAG]).replace('"apiClientId":1780363', '"apiClientId":42');
    addShopifyPixelsConfig([legacy, otherApp]);
    expect(shopifyPageConfiguresGoogleAppTag('G-LEGACY')).toBe(true);
    expect(shopifyPageConfiguresGoogleAppTag(GOOGLE_TAG)).toBe(false);
  });

  test('TikTok: pixelCode of apiClientId 4383523 only', () => {
    addShopifyPixelsConfig([tiktokAppEntry('OTHERCODE'), tiktokAppEntry(TIKTOK_CODE, 42)]);
    expect(shopifyPageConfiguresTikTokAppPixel(TIKTOK_CODE)).toBe(false);
    expect(shopifyPageConfiguresTikTokAppPixel('OTHERCODE')).toBe(true);
  });

  test('a list that is no longer JSON still yields the Meta match; Google/TikTok stay conservative', () => {
    const script = document.createElement('script');
    script.text = '(function(){var wpmLoader=function(){};wpmLoader({webPixelsConfigList: [{id: 1, apiClientId: 4383523, configuration: "{\\"pixelCode\\":\\"' + TIKTOK_CODE + '\\"}"},'
      + '{"configuration":"{\\"pixel_id\\":\\"' + PIXEL + '\\",\\"pixel_type\\":\\"facebook_pixel\\"}"}]});})();';
    document.head.appendChild(script);
    expect(shopifyPageConfiguresFacebookAppPixel(PIXEL)).toBe(true);
    expect(shopifyPageConfiguresTikTokAppPixel(TIKTOK_CODE)).toBe(false);
  });

  test('external scripts are not read', () => {
    const external = document.createElement('script');
    external.src = 'https://cdn.example/wpm.js';
    external.text = 'webPixelsConfigList [{"configuration":"{\\"pixel_id\\":\\"' + PIXEL + '\\",\\"pixel_type\\":\\"facebook_pixel\\"}"}]';
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
    resetPage();
    jest.useRealTimers();
  });

  async function companionManager(options: { canForward?: () => boolean } = {}): Promise<ContainerManager> {
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify', ...options });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(true);
    return manager;
  }

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

    expect(queuedCommands(fbq.queue).slice(before)).toEqual([
      ['trackSingle', PIXEL, 'AddToCart', { value: 25, currency: 'GBP' }, { eventID: 'atc-1' }],
    ]);
    // Only the app ever called init; we never set anything on its pixel.
    expect(queuedCommands(fbq.queue).filter((c) => c[0] === 'init')).toEqual([
      ['init', PIXEL, {}, { agent: 'shopify_web_pixel' }],
    ]);
    expect(queuedCommands(fbq.queue).some((c) => c[0] === 'set' && c[1] !== 'shopifySandboxContext')).toBe(false);
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

    expect(queuedCommands(fbq.queue).slice(before)).toEqual([
      ['trackSingle', PIXEL, 'CompleteRegistration', {}, { eventID: 'e1' }],
      ['trackSingleCustom', PIXEL, 'QuizDone', { score: 3 }, { eventID: 'e2' }],
      ['trackSingle', PIXEL, 'Purchase', { value: 9 }, { eventID: 'e4' }],
    ]);
  });

  test('without the app config the Shopify store keeps full behaviour (autoConfig off, init, trackSingleOnly, PageView)', async () => {
    addShopifyPixelsConfig([OTHER_APP_ENTRY, fbAppEntry('999')]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(manager.isMetaCompanionMode()).toBe(false);
    expect(fbeventsScripts()).toHaveLength(1);
    const fbq = (window as any).fbq;
    expect(await manager.trackToPixels('pageview', {}, 'pv-1')).toEqual(['meta']);
    expect(queuedCommands(fbq.queue)).toEqual([
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
      ['set', 'trackSingleOnly', true, PIXEL],
      ['trackSingle', PIXEL, 'PageView', {}, { eventID: 'pv-1' }],
    ]);
  });

  test('a non-Shopify page keeps full behaviour', async () => {
    // dl.js's own tag: the fbevents loader inserts before the first script.
    document.head.appendChild(document.createElement('script'));
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(false);
    expect(fbeventsScripts()).toHaveLength(1);
  });

  test.each([
    ['window.Shopify present', () => { (window as any).Shopify = { shop: 'x.myshopify.com' }; }],
    ['only the Shopify page config', () => undefined],
  ])('plain-snippet install (no data-platform), %s: companion mode', async (_name, arrange) => {
    arrange();
    addShopifyPixelsConfig([fbAppEntry(PIXEL)]);
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(true);
    expect(fbeventsScripts()).toHaveLength(0);
    expect((window as any).fbq).toBeUndefined();
  });

  test('load-order race: an event tracked before the app pixel exists waits, then goes out after its init', async () => {
    jest.useFakeTimers();
    await companionManager();

    let result: string[] | undefined;
    const pending = manager!.trackToPixels('view_content', { content_ids: ['8087288315952'] }, 'vc-1')
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
    const commands = queuedCommands(fbq.queue);
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

  test('loaded fbevents without our pixel initialized is not ready: the event waits for the app init', async () => {
    jest.useFakeTimers();
    await companionManager();
    // fbevents already on the page (another pixel), the app has not rendered yet.
    const fbq: any = jest.fn();
    fbq.callMethod = jest.fn();
    fbq.queue = [];
    fbq.instance = { pixelsByID: { '999': { agent: null } } };
    (window as any).fbq = fbq;

    let result: string[] | undefined;
    const pending = manager!.trackToPixels('add_to_cart', {}, 'atc-5').then((sent) => { result = sent; });
    await jest.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    expect(fbq).not.toHaveBeenCalled();

    fbq.instance.pixelsByID[PIXEL] = { agent: 'shopify_web_pixel' };
    await jest.advanceTimersByTimeAsync(250);
    await pending;
    expect(result).toEqual(['meta']);
    expect(fbq).toHaveBeenCalledWith('trackSingle', PIXEL, 'AddToCart', {}, { eventID: 'atc-5' });
  });

  test('bounded wait: when the app pixel never appears the browser copy is skipped', async () => {
    jest.useFakeTimers();
    await companionManager();

    let result: string[] | undefined;
    const pending = manager!.trackToPixels('add_to_cart', {}, 'atc-3').then((sent) => { result = sent; });
    await jest.advanceTimersByTimeAsync(9000);
    expect(result).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1500);
    await pending;
    expect(result).toEqual([]);
    expect((window as any).fbq).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('at most 50 events wait; the 51st skips its browser copy at once', async () => {
    jest.useFakeTimers();
    await companionManager();

    const waiting = Array.from({ length: 50 }, (_, i) => manager!.trackToPixels('add_to_cart', { n: i }, 'w-' + i));
    await jest.advanceTimersByTimeAsync(0);
    expect(await manager!.trackToPixels('add_to_cart', { n: 50 }, 'w-50')).toEqual([]);

    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    await jest.advanceTimersByTimeAsync(250);
    const results = await Promise.all(waiting);
    expect(results.every((sent) => sent.length === 1 && sent[0] === 'meta')).toBe(true);
    const ours = queuedCommands(fbq.queue).filter((c) => c[0] === 'trackSingle');
    expect(ours).toHaveLength(50);
    expect(ours.some((c) => (c[4] as any).eventID === 'w-50')).toBe(false);
  });

  test('consent withdrawn during the wait: nothing is sent once the app pixel appears', async () => {
    jest.useFakeTimers();
    let allowed = true;
    await companionManager({ canForward: () => allowed });

    const pending = manager!.trackToPixels('add_to_cart', {}, 'atc-6');
    await jest.advanceTimersByTimeAsync(500);
    allowed = false;
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    await jest.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual([]);
    expect(queuedCommands(fbq.queue).some((c) => c[0] === 'trackSingle')).toBe(false);
  });

  test('cleanup (consent withdrawn) releases waiting events without sending', async () => {
    jest.useFakeTimers();
    await companionManager();
    const pending = manager!.trackToPixels('add_to_cart', {}, 'atc-4');
    await jest.advanceTimersByTimeAsync(250);
    manager!.cleanupAllIframes();
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    expect(await pending).toEqual([]);
    expect(queuedCommands(fbq.queue).some((c) => c[0] === 'trackSingle')).toBe(false);
  });

  test('runtime fallback: the app already initialized the pixel before the container ran', async () => {
    mockPixels();
    const fbq = installAppFbqStub();
    appRendersPixel(fbq);
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(true);
    expect(fbeventsScripts()).toHaveLength(0);
    expect(queuedCommands(fbq.queue).filter((c) => c[0] === 'init')).toHaveLength(1);
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
    resetPage();
  });

  test('autoConfig off before init; no trackSingleOnly when no other pixel shares fbq', async () => {
    mockPixels();
    const fbq: any = jest.fn();
    (window as any).fbq = fbq;
    manager = new ContainerManager({
      workspaceId: 'ws',
      getIdentity: () => ({ externalId: 'visitor-1' }),
    });
    await manager.init();

    // A merchant tag (GTM, a plugin) that inits this pixel after us must keep
    // its broadcast track() calls: trackSingleOnly would silence them.
    const calls = fbq.mock.calls.map((c: unknown[]) => c.slice(0, 2).join(':'));
    expect(calls).toEqual(['set:autoConfig', 'init:' + PIXEL]);
    expect(fbq.mock.calls[0]).toEqual(['set', 'autoConfig', false, PIXEL]);
  });

  test('trackSingleOnly only when the Shopify page runs a Facebook app pixel with another id', async () => {
    addShopifyPixelsConfig([fbAppEntry('999')]);
    mockPixels();
    const fbq: any = jest.fn();
    (window as any).fbq = fbq;
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    const calls = fbq.mock.calls.map((c: unknown[]) => c.slice(0, 2).join(':'));
    expect(calls).toEqual(['set:autoConfig', 'init:' + PIXEL, 'set:trackSingleOnly']);
    expect(fbq.mock.calls[2]).toEqual(['set', 'trackSingleOnly', true, PIXEL]);
  });

  test('a Shopify app running a DIFFERENT pixel: ours is single-only and our events never broadcast', async () => {
    addShopifyPixelsConfig([fbAppEntry('999')]);
    const fbq = installAppFbqStub();
    appRendersPixel(fbq, '999');
    mockPixels();
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    const before = fbq.queue.length;

    await manager.trackToPixels('pageview', {}, 'pv-9');
    await manager.trackToPixels('quiz_done', {}, 'q-9');
    expect(queuedCommands(fbq.queue).slice(before - 3)).toEqual([
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
      ['set', 'trackSingleOnly', true, PIXEL],
      ['trackSingle', PIXEL, 'PageView', {}, { eventID: 'pv-9' }],
      ['trackSingleCustom', PIXEL, 'quiz_done', {}, { eventID: 'q-9' }],
    ]);
    expect(queuedCommands(fbq.queue).some((c) => c[0] === 'track' || c[0] === 'trackCustom')).toBe(false);
  });

  test('a pixel theme code already initialized is left broadcastable (no trackSingleOnly)', async () => {
    mockPixels();
    const fbq = installAppFbqStub();
    fbq('init', PIXEL);
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.isMetaCompanionMode()).toBe(false);
    expect(queuedCommands(fbq.queue).slice(1)).toEqual([
      ['set', 'autoConfig', false, PIXEL],
      ['init', PIXEL],
    ]);
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

  test('a failed init can be retried by a later init() call', async () => {
    const fbq: any = jest.fn();
    (window as any).fbq = fbq;
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, json: async () => ({ scripts: [], pixels: { meta: { enabled: true, pixel_id: PIXEL } } }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    manager = new ContainerManager({ workspaceId: 'ws' });

    await manager.init();
    expect(fbq).not.toHaveBeenCalled();
    await manager.init();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    // autoConfig, init, then our event; no trackSingleOnly (no other pixel shares fbq).
    expect(fbq.mock.calls.map((c: unknown[]) => c[0])).toEqual(['set', 'init', 'trackSingle']);
    expect(fbq).toHaveBeenLastCalledWith('trackSingle', PIXEL, 'PageView', {}, { eventID: 'pv-early' });
  });

  test('the dashboard config reaches the SDK before any pixel loads (strict blocks the load)', async () => {
    mockConfig({ meta: { enabled: true, pixel_id: PIXEL }, google: { enabled: true, tag_id: GOOGLE_TAG } }, { privacyMode: 'strict' });
    let strict = false;
    const seen: unknown[] = [];
    manager = new ContainerManager({
      workspaceId: 'ws',
      canForward: () => !strict,
      onRemoteConfig: (remote) => { seen.push(remote); strict = remote?.privacyMode === 'strict'; },
    });
    await manager.init();
    expect(seen).toEqual([{ privacyMode: 'strict' }]);
    expect((window as any).fbq).toBeUndefined();
    expect((window as any).gtag).toBeUndefined();
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
  });
});

describe('Google & YouTube and TikTok companion mode on Shopify', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;

  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
    jest.useRealTimers();
  });

  test('Google app with our tag: no gtag.js, no config/page_view; events mirror with send_to once the app configured the tag', async () => {
    jest.useFakeTimers();
    addShopifyPixelsConfig([googleAppEntry([GOOGLE_TAG, 'AW-727142071'])]);
    mockConfig({ google: { enabled: true, tag_id: GOOGLE_TAG } });
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(manager.getCompanionModes().google).toBe(true);
    expect(scriptsFrom('googletagmanager.com')).toHaveLength(0);
    expect((window as any).gtag).toBeUndefined();

    expect(await manager.trackToPixels('pageview', {}, 'pv-g')).toEqual([]);
    let result: string[] | undefined;
    const pending = manager.trackToPixels('add_to_cart', { value: 5 }, 'atc-g').then((sent) => { result = sent; });
    await jest.advanceTimersByTimeAsync(500);
    expect(result).toBeUndefined();

    const dataLayer = googleAppConfiguresTag();
    await jest.advanceTimersByTimeAsync(250);
    await pending;
    expect(result).toEqual(['google']);
    const events = queuedCommands(dataLayer).filter((c) => c[0] === 'event');
    expect(events).toEqual([['event', 'add_to_cart', { value: 5, send_to: GOOGLE_TAG }]]);
    expect(queuedCommands(dataLayer).filter((c) => c[0] === 'config')).toHaveLength(1); // the app's only
  });

  test('Google app configuring a different tag: our tag keeps full behaviour', async () => {
    addShopifyPixelsConfig([googleAppEntry(['G-OTHER'])]);
    mockConfig({ google: { enabled: true, tag_id: GOOGLE_TAG } });
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.getCompanionModes().google).toBe(false);
    expect(scriptsFrom('googletagmanager.com/gtag/js?id=' + GOOGLE_TAG)).toHaveLength(1);
    expect((window as any).dataLayer.some((c: unknown[]) => c[0] === 'config' && c[1] === GOOGLE_TAG)).toBe(true);
  });

  test('TikTok app with our pixel code: no ttq load or page(); no browser copy without a top-page instance', async () => {
    addShopifyPixelsConfig([tiktokAppEntry(TIKTOK_CODE)]);
    mockConfig({ tiktok: { enabled: true, pixel_id: TIKTOK_CODE } });
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(manager.getCompanionModes().tiktok).toBe(true);
    expect((window as any).ttq).toBeUndefined();
    expect(scriptsFrom('analytics.tiktok.com')).toHaveLength(0);
    expect(await manager.trackToPixels('add_to_cart', { value: 5 }, 'atc-t')).toEqual([]);
  });

  test('TikTok companion mirrors through a top-page instance of the same pixel, never broadcast or page', async () => {
    addShopifyPixelsConfig([tiktokAppEntry(TIKTOK_CODE)]);
    mockConfig({ tiktok: { enabled: true, pixel_id: TIKTOK_CODE } });
    const instance = { track: jest.fn() };
    const ttq: any = { track: jest.fn(), page: jest.fn(), load: jest.fn(), _i: { [TIKTOK_CODE]: [] }, instance: jest.fn(() => instance) };
    (window as any).ttq = ttq;
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();

    expect(ttq.load).not.toHaveBeenCalled();
    expect(ttq.page).not.toHaveBeenCalled();
    expect(await manager.trackToPixels('pageview', {}, 'pv-t')).toEqual([]);
    expect(await manager.trackToPixels('add_to_cart', { value: 5 }, 'atc-t')).toEqual(['tiktok']);
    expect(ttq.instance).toHaveBeenCalledWith(TIKTOK_CODE);
    expect(instance.track).toHaveBeenCalledWith('AddToCart', { value: 5 });
    expect(ttq.track).not.toHaveBeenCalled();
  });

  test('without the TikTok app the pixel loads and pages as before', async () => {
    addShopifyPixelsConfig([tiktokAppEntry('OTHERCODE')]);
    mockConfig({ tiktok: { enabled: true, pixel_id: TIKTOK_CODE } });
    manager = new ContainerManager({ workspaceId: 'ws', platform: 'shopify' });
    await manager.init();
    expect(manager.getCompanionModes().tiktok).toBe(false);
    const ttq = (window as any).ttq;
    expect(ttq._i[TIKTOK_CODE]).toBeDefined();
    expect(queuedCommands(ttq).some((c) => c[0] === 'page')).toBe(true);
  });
});
