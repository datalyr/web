/**
 * X Pixel in the Container, through the destination pixels module
 * (dl.pixels.<v>.js): loaded like X's base code (twq stub, uwt.js,
 * twq('config') which sends X's page view), only with marketing consent and
 * without DNT / GPC / a US opt-out, never next to another X install, and every
 * twq('event') carries the conversion_id the X sender puts on the server copy.
 */
import { ContainerManager } from './container';
import { PIXELS_GLOBAL } from './destination-pixels';
import { createPixelsModule } from './pixels';
import { X_PIXEL_SCRIPT, xContents, xConversionId, xEventIdFor, xPixelOnPage } from './pixels/x';
import { APPLOVIN_PIXEL_SCRIPTS } from './pixels/applovin';

const PIXEL = 'q19sf';
const EVENTS = { purchase: 'tw-q19sf-q19sg', signup_done: 'q19sh', product_added: 'tw-q19sf-q19si', pageview: 'tw-q19sf-q19sj', bad: 'not an id!' };

function twqCalls(): unknown[][] {
  const twq = (window as any).twq;
  return twq && twq.queue ? Array.from(twq.queue as ArrayLike<ArrayLike<unknown>>).map((args) => Array.from(args)) : [];
}
const events = () => twqCalls().filter((call) => call[0] === 'event');
const xScripts = () => Array.from(document.querySelectorAll('script')).map((s) => s.src).filter((src) => src === X_PIXEL_SCRIPT);

function respond(pixels: Record<string, unknown>): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).startsWith('https://b.applovin.com/')) return { ok: true, json: async () => ({ autoSpaPageView: true }) };
    return { ok: true, json: async () => ({ scripts: [], pixels }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
function x(extra: Record<string, unknown> = {}) {
  return { x: { enabled: true, pixel_id: PIXEL, events: EVENTS, values: ['product_added'], purchases: ['purchase'], ...extra } };
}
function clearGlobal(key: string): void {
  try { delete (window as any)[key]; } catch { (window as any)[key] = undefined; }
}
function resetPage(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const key of ['twq', 'axon', 'AXON_EVENT_KEY', 'Shopify', 'globalPrivacyControl', '__uspapi', '__datalyrLandingPageView', PIXELS_GLOBAL]) clearGlobal(key);
  delete (navigator as any).globalPrivacyControl;
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
  document.cookie = 'usprivacy=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
}
/**
 * uwt.js arriving: it sets twq.exe, which the base-code stub then calls
 * instead of queueing. Recorded into the same queue so twqCalls() reads both.
 */
function uwtLoads(): void {
  const twq = (window as any).twq;
  if (twq && twq.__datalyr) twq.exe = (...args: unknown[]) => { twq.queue.push(args); };
}
async function started(options: { canForward?: () => boolean; uwt?: boolean } = {}): Promise<ContainerManager> {
  const { uwt = true, ...rest } = options;
  const manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10', ...rest });
  await manager.init();
  await manager.destinationPixelStatus('x');
  if (uwt) uwtLoads();
  return manager;
}

describe('X Pixel: loading and gating', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    document.head.appendChild(document.createElement('script'));
    (window as any)[PIXELS_GLOBAL] = createPixelsModule();
  });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test("loads like X's base code: twq stub 1.1, uwt.js, then config (X's page view)", async () => {
    respond(x());
    manager = await started();
    expect(await manager.destinationPixelStatus('x')).toBe('loaded');
    expect((window as any).twq.version).toBe('1.1');
    expect(xScripts()).toEqual([X_PIXEL_SCRIPT]);
    expect(twqCalls()).toEqual([['config', PIXEL]]);
  });

  test('page views never go out as X events (config counted the landing one)', async () => {
    respond(x());
    manager = await started();
    expect(await manager.trackToPixels('pageview', {}, 'evt-1')).toEqual([]);
    expect(await manager.trackToPixels('pageview', {}, 'evt-2')).toEqual([]);
    expect(twqCalls()).toEqual([['config', PIXEL]]);
  });

  test('no marketing consent: nothing loads, the module is not fetched', async () => {
    clearGlobal(PIXELS_GLOBAL);
    const fetchMock = respond(x());
    manager = await started({ canForward: () => false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((window as any).twq).toBeUndefined();
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
  });

  test.each([
    ['DNT', () => Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })],
    ['GPC (window)', () => { (window as any).globalPrivacyControl = true; }],
    ['GPC (navigator)', () => { (navigator as any).globalPrivacyControl = true; }],
    ['us_privacy 1YYN', () => { document.cookie = 'usprivacy=1YYN; path=/'; }],
  ])('%s: the X Pixel never loads', async (_name, setSignal) => {
    setSignal();
    respond(x());
    manager = await started();
    expect((window as any).twq).toBeUndefined();
    expect(xScripts()).toHaveLength(0);
    expect(await manager.trackToPixels('purchase', { order_id: 'o1' }, 'e1')).toEqual([]);
  });

  test('no config, disabled, or a malformed pixel id: nothing loads', async () => {
    for (const pixels of [{}, { x: { enabled: false, pixel_id: PIXEL } }, { x: { enabled: true, pixel_id: 'a b' } }]) {
      respond(pixels);
      manager = await started();
      expect((window as any).twq).toBeUndefined();
      manager.cleanupAllIframes();
    }
  });

  test('consent or a GPC signal withdrawn after load: later events are not sent', async () => {
    respond(x());
    let allowed = true;
    manager = await started({ canForward: () => allowed });
    expect(await manager.trackToPixels('signup_done', {}, 'e1')).toEqual(['x']);
    allowed = false;
    expect(await manager.trackToPixels('signup_done', {}, 'e2')).toEqual([]);
    allowed = true;
    (navigator as any).globalPrivacyControl = true;
    expect(await manager.trackToPixels('signup_done', {}, 'e3')).toEqual([]);
    expect(events()).toHaveLength(1);
  });

  test('uwt.js blocked (never loads): the event waits in the queue and is not reported delivered', async () => {
    respond(x());
    manager = await started({ uwt: false });
    expect(await manager.trackToPixels('signup_done', {}, 'e1')).toEqual([]);
    expect(events()).toEqual([['event', 'tw-q19sf-q19sh', { conversion_id: 'e1' }]]);
  });

  test('X and AppLovin come from one module load', async () => {
    clearGlobal(PIXELS_GLOBAL);
    respond({ ...x(), applovin: { enabled: true, event_key: 'AxKey', account_type: 'purchase', events: {} } });
    manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10' });
    await manager.init();
    const injected = Array.from(document.querySelectorAll('script')).filter((s) => s.dataset.datalyrPixel === 'module');
    expect(injected).toHaveLength(1);
    (window as any)[PIXELS_GLOBAL] = createPixelsModule();
    injected[0].dispatchEvent(new Event('load'));
    expect(await manager.destinationPixelStatus('x')).toBe('loaded');
    expect(await manager.destinationPixelStatus('applovin')).toBe('loaded');
    expect(xScripts()).toHaveLength(1);
    expect(Array.from(document.querySelectorAll('script')).filter((s) => APPLOVIN_PIXEL_SCRIPTS.includes(s.src))).toHaveLength(2);
  });
});

describe('X Pixel: another install already on the page', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => { (window as any)[PIXELS_GLOBAL] = createPixelsModule(); });
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

  test('window.twq already there (theme code, GTM, an app): no second pixel, nothing sent through it', async () => {
    const theirs: any = jest.fn();
    (window as any).twq = theirs;
    respond(x());
    manager = await started();
    expect(await manager.destinationPixelStatus('x')).toBe('companion');
    expect(xScripts()).toHaveLength(0);
    expect(await manager.trackToPixels('purchase', { order_id: 'o1' }, 'e1')).toEqual([]);
    expect(theirs).not.toHaveBeenCalled();
  });

  test("X's base code is in the HTML but has not run yet", async () => {
    inline("!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){},u.src='https://static.ads-twitter.com/uwt.js')}(window,document,'script');twq('config','abcde');", 'text/plain');
    respond(x());
    manager = await started();
    expect(await manager.destinationPixelStatus('x')).toBe('companion');
  });

  test('detection matches the base code itself, not mentions of uwt.js', () => {
    inline("var urls=['https://static.ads-twitter.com/uwt.js'];", 'text/plain');
    expect(xPixelOnPage(PIXEL)).toBe(false);
    const ours = document.createElement('script');
    ours.src = X_PIXEL_SCRIPT;
    ours.dataset.datalyrPixel = 'x';
    document.head.appendChild(ours);
    expect(xPixelOnPage(PIXEL)).toBe(false);
    const theirs = document.createElement('script');
    theirs.src = X_PIXEL_SCRIPT;
    document.head.appendChild(theirs);
    expect(xPixelOnPage(PIXEL)).toBe(true);
  });

  test("window.twq replaced by X's own code after load: sending continues through it, and is logged", async () => {
    respond(x());
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    manager = new ContainerManager({ workspaceId: 'ws', sdkVersion: '1.9.10', debug: true });
    await manager.init();
    await manager.destinationPixelStatus('x');
    const xOwn: any = jest.fn();
    xOwn.exe = jest.fn();
    xOwn.version = '1.1';
    (window as any).twq = xOwn;
    expect(await manager.trackToPixels('signup_done', {}, 'e1')).toEqual(['x']);
    expect(xOwn).toHaveBeenCalledWith('event', 'tw-q19sf-q19sh', { conversion_id: 'e1' });
    expect(log.mock.calls.some((call) => String(call[1]).includes("replaced by X's own code"))).toBe(true);
    log.mockRestore();
  });

  test.each([
    ['a GTM tag adds uwt.js', () => { const s = document.createElement('script'); s.src = X_PIXEL_SCRIPT; document.head.appendChild(s); }],
    ['another install replaces window.twq', () => { (window as any).twq = jest.fn(); }],
  ])('a late install (%s): forwarding stops', async (_name, arrive) => {
    respond(x());
    manager = await started();
    expect(await manager.trackToPixels('signup_done', {}, 'e1')).toEqual(['x']);
    arrive();
    expect(await manager.trackToPixels('signup_done', {}, 'e2')).toEqual([]);
  });
});

describe('X Pixel: events', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager | undefined;
  beforeEach(() => {
    document.head.appendChild(document.createElement('script'));
    (window as any)[PIXELS_GLOBAL] = createPixelsModule();
  });
  afterEach(() => {
    manager?.cleanupAllIframes();
    manager = undefined;
    global.fetch = originalFetch;
    resetPage();
  });

  test("only events with a website X rule, under the rule's full Event ID; conversion_id per the sender", async () => {
    respond(x());
    manager = await started();
    // A purchase whose value the server would not take from the browser
    // (not in `values`): left to the server entirely.
    expect(await manager.trackToPixels('purchase', { order_id: 6896206413937, value: 99, currency: 'eur' }, 'evt-p0')).toEqual([]);
    // A bare Event ID gets the pixel prefix; a non-purchase uses the event id.
    await manager.trackToPixels('signup_done', { order_id: 'not-used' }, 'evt-signup');
    // Value allowed for this one.
    await manager.trackToPixels('product_added', { value: 12.345, currency: 'gbp', product_id: 'p2' }, 'evt-cart');
    // Unmapped, malformed id, internal: nothing.
    expect(await manager.trackToPixels('lead', {}, 'e-x')).toEqual([]);
    expect(await manager.trackToPixels('bad', {}, 'e-bad')).toEqual([]);
    expect(await manager.trackToPixels('$identify', {}, 'e-int')).toEqual([]);
    expect(events()).toEqual([
      ['event', 'tw-q19sf-q19sh', { conversion_id: 'evt-signup' }],
      ['event', 'tw-q19sf-q19si', { conversion_id: 'evt-cart', value: 12.35, currency: 'GBP' }],
    ]);
    // Never personal data from the browser.
    expect(JSON.stringify(events())).not.toMatch(/a@b\.co|email|phone/);
  });

  test('purchase: only as strong as the server copy (in values, value above 0, the event\'s own currency)', async () => {
    respond(x({ values: ['purchase', 'product_added'] }));
    manager = await started();
    expect(await manager.trackToPixels('purchase', { order_id: 'o0', value: 0, currency: 'USD' }, 'e0')).toEqual([]);
    // No USD default: a purchase without its own currency is left to the server.
    expect(await manager.trackToPixels('purchase', { order_id: 'o1', value: 25 }, 'e1')).toEqual([]);
    expect(await manager.trackToPixels('purchase', { order_id: 6896206413937, value: 25, currency: 'eur',
      items: [{ product_id: 'p1', sku: 'SKU-1', title: 'Tee', price: 12.5, quantity: 2 }], email: 'a@b.co' }, 'e2')).toEqual(['x']);
    // Without an order reference the conversion_id is the DATALYR event id.
    expect(await manager.trackToPixels('purchase', { value: 10, currency: 'USD' }, 'evt-p')).toEqual(['x']);
    // A non-purchase without its own currency goes without a value.
    await manager.trackToPixels('product_added', { value: 3 }, 'e3');
    expect(events()).toEqual([
      ['event', 'tw-q19sf-q19sg', { conversion_id: '6896206413937', value: 25, currency: 'EUR',
        contents: [{ content_id: 'SKU-1', content_group_id: 'p1', content_name: 'Tee', content_price: 12.5, num_items: 2 }] }],
      ['event', 'tw-q19sf-q19sg', { conversion_id: 'evt-p', value: 10, currency: 'USD' }],
      ['event', 'tw-q19sf-q19si', { conversion_id: 'e3' }],
    ]);
    expect(JSON.stringify(events())).not.toMatch(/a@b\.co|email|phone/);
  });

  test('ids come from the raw properties: an order id sanitising would alter is the conversion_id as the server has it', async () => {
    respond(x({ values: ['purchase'] }));
    manager = await started();
    await manager.trackToPixels('purchase', { order_id: 'ORD<7>onx=1', value: 5, currency: 'USD' }, 'e1');
    expect((events()[0][2] as any).conversion_id).toBe('ORD<7>onx=1');
  });

  test('a pixel-only co-fire (destinationPixels: false) never reaches X', async () => {
    respond(x({ values: ['purchase'] }));
    manager = await started();
    expect(await manager.trackToPixels('purchase', { order_id: 'CC-1', value: 5, currency: 'USD' }, 'cc', { destinationPixels: false })).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('no event id: not sent (except a purchase with an order reference)', async () => {
    respond(x({ values: ['purchase'] }));
    manager = await started();
    expect(await manager.trackToPixels('signup_done', {})).toEqual([]);
    expect(await manager.trackToPixels('purchase', { order_id: 'A-1', value: 2, currency: 'USD' })).toEqual(['x']);
  });

  test('the current policy must still allow X with the same pixel id', async () => {
    respond(x());
    manager = await started();
    respond(x({ pixel_id: 'other' }));
    expect(await manager.trackToPixels('signup_done', {}, 'e1')).toEqual([]);
    respond({});
    expect(await manager.trackToPixels('signup_done', {}, 'e2')).toEqual([]);
    expect(events()).toHaveLength(0);
  });
});

describe('X mirrors of the sender contract', () => {
  test('Event IDs: full form kept, bare ones prefixed with the pixel, anything else refused', () => {
    expect(xEventIdFor('a', { pixel_id: PIXEL, events: { a: 'tw-q19sf-q19sg' } })).toBe('tw-q19sf-q19sg');
    expect(xEventIdFor('a', { pixel_id: PIXEL, events: { a: 'q19sg' } })).toBe('tw-q19sf-q19sg');
    expect(xEventIdFor('a', { pixel_id: PIXEL, events: { a: 'tw-q19sf q19sg' } })).toBeNull();
    expect(xEventIdFor('toString', { pixel_id: PIXEL, events: {} })).toBeNull();
  });
  test.each([
    [{ purchase: true, properties: { order_id: 'O-1' }, eventId: 'e' }, 'O-1'],
    [{ purchase: true, properties: { transaction_id: 77 }, eventId: 'e' }, '77'],
    [{ purchase: true, properties: { object: 'invoice', id: 'in_1' }, eventId: 'e' }, 'in_1'],
    [{ purchase: true, properties: {}, eventId: 'e' }, 'e'],
    [{ purchase: false, properties: { order_id: 'O-1' }, eventId: 'e' }, 'e'],
  ])('conversion_id %p → %p (x-payload.js xConversionId)', (input, expected) => {
    expect(xConversionId(input)).toBe(expected);
  });
  test('contents follow mapXContent: SKU first, the product as the group, integer num_items', () => {
    expect(xContents({ line_items: [{ variant_id: 'v1', product_id: 'p1', price: '10', quantity: 2.4 }] }))
      .toEqual([{ content_id: 'v1', content_group_id: 'p1', content_price: 10, num_items: 2 }]);
  });
  test("item lists are read in the sender's ITEM_LIST_PATHS order (properties.items before contents)", () => {
    expect(xContents({ contents: [{ id: 'c' }], properties: { items: [{ id: 'nested' }] } }))
      .toEqual([{ content_id: 'nested', num_items: 1 }]);
  });
});
