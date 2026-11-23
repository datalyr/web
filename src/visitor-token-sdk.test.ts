/**
 * FX-083 signed visitor token, wired into the SDK (full init, network mocked).
 * Every setting ships off; the first block proves nothing changes while they are.
 */
export {}; // module scope: index.test.ts declares helper names globally

type SdkModule = typeof import('./index');

const tok = (c: string): string => 'dv1' + c.repeat(54);
const T1 = tok('A');
const T2 = tok('B');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

let tokens: string[];
let fetchMock: jest.Mock;

function mockNetwork(): jest.Mock {
  fetchMock = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/v1/visitor-token')) {
      const token = tokens.shift();
      return token
        ? { ok: true, status: 200, json: async () => ({ token, expires_in: 7200 }) }
        : { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function tokenCalls(): any[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/visitor-token'));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const baseConfig = {
  workspaceId: 'ws-token',
  enableFingerprinting: false,
  enablePerformanceTracking: false,
  enableContainer: false,
  trackPageViews: false,
  trackSPA: false,
  stripeCheckoutSessions: false,
  inAppHandoff: false,
};

const originalFetch = global.fetch;
let instance: any;

async function boot(config: Record<string, unknown> = {}): Promise<any> {
  const sdk = loadSdk();
  instance = sdk.createDatalyrInstance();
  instance.init({ ...baseConfig, ...config });
  await instance.ready();
  await settle();
  return instance;
}

function addLink(href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  document.body.appendChild(a);
  return a;
}

const cancelNav = (e: Event) => e.preventDefault();
beforeAll(() => document.addEventListener('click', cancelNav));
afterAll(() => document.removeEventListener('click', cancelNav));

beforeEach(() => {
  tokens = [T1, T2];
  mockNetwork();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  instance?.destroy();
  instance = undefined;
  global.fetch = originalFetch;
  delete (window as any).datalyr;
  document.body.innerHTML = '';
  document.cookie = '__dl_opt_out=; path=/; max-age=0';
  document.cookie = '__dl_visitor_id=; path=/; max-age=0';
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  jest.restoreAllMocks();
});

describe('all settings off (the default)', () => {
  test('no token request, getVisitorToken() resolves null', async () => {
    addLink('https://buy.stripe.com/test_1');
    addLink('https://calendly.com/team/intro');
    const sdk = await boot();
    await expect(sdk.getVisitorToken()).resolves.toBeNull();
    sdk.getStripeMetadata();
    sdk.getWhopCheckoutMetadata();
    await settle();
    expect(tokenCalls()).toHaveLength(0);
    expect(sessionStorage.getItem('dl_vt')).toBeNull();
  });

  test('getters return exactly what they returned before', async () => {
    const sdk = await boot();
    const vid = sdk.getVisitorId();
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: vid, metadata: { visitor_id: vid } });
    expect(sdk.getWhopCheckoutMetadata()).toEqual({ visitor_id: vid });
  });
});

describe('getVisitorToken() with a provider switched on', () => {
  test('mints once for the current visitor and caches it', async () => {
    const sdk = await boot({ visitorToken: { stripe: true } });
    await expect(sdk.getVisitorToken()).resolves.toBe(T1);
    await expect(sdk.getVisitorToken()).resolves.toBe(T1);
    expect(tokenCalls()).toHaveLength(1);
    const [url, init] = tokenCalls()[0];
    expect(url).toBe('https://ingest.datalyr.com/v1/visitor-token');
    expect(JSON.parse(init.body)).toEqual({ workspace_id: 'ws-token', visitor_id: sdk.getVisitorId() });
    expect(init.headers['X-DL-Consent']).toBe('granted');
  });

  test('no request on a page without a decoratable link until a getter asks', async () => {
    await boot({ visitorToken: { stripe: true, calendly: true, iclosed: true } });
    expect(tokenCalls()).toHaveLength(0);
  });

  test('never when marketing consent is denied or the visitor opted out', async () => {
    const sdk = await boot({ visitorToken: { whop: true } });
    sdk.setConsent({ marketing: false });
    await expect(sdk.getVisitorToken()).resolves.toBeNull();
    sdk.setConsent({ marketing: true });
    sdk.optOut();
    await expect(sdk.getVisitorToken()).resolves.toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });

  test("reset() clears the cached token; the next one names the new visitor", async () => {
    const sdk = await boot({ visitorToken: { stripe: true } });
    await sdk.getVisitorToken();
    const before = sdk.getVisitorId();
    expect(sessionStorage.getItem('dl_vt')).not.toBeNull();
    sdk.reset();
    expect(sessionStorage.getItem('dl_vt')).toBeNull();
    await expect(sdk.getVisitorToken()).resolves.toBe(T2);
    const after = JSON.parse(tokenCalls()[1][1].body).visitor_id;
    expect(after).toBe(sdk.getVisitorId());
    expect(after).not.toBe(before);
  });

  test('an inbound dl_vt in the page URL is never adopted', async () => {
    window.history.replaceState(null, '', `/landing?dl_vt=${T2}`);
    const sdk = await boot({ visitorToken: { stripe: true } });
    expect(sdk.getVisitorId()).toMatch(/^anon_[0-9a-f-]{36}$/);
    expect(sessionStorage.getItem('dl_vt')).toBeNull();
    await expect(sdk.getVisitorToken()).resolves.toBe(T1);
    expect(JSON.parse(tokenCalls()[0][1].body).visitor_id).toBe(sdk.getVisitorId());
  });
});

describe('C13: Stripe Payment Links carry the token', () => {
  test('off: the raw visitor id is stamped as today', async () => {
    const a = addLink('https://buy.stripe.com/test_1');
    const sdk = await boot();
    expect(new URL(a.href).searchParams.get('client_reference_id')).toBe(sdk.getVisitorId());
  });

  test('on: client_reference_id is the token, never the raw id', async () => {
    const a = addLink('https://buy.stripe.com/test_1');
    const sdk = await boot({ visitorToken: { stripe: true } });
    await settle();
    const ref = new URL(a.href).searchParams.get('client_reference_id');
    expect(ref).toBe(T1);
    expect(ref).not.toBe(sdk.getVisitorId());
    expect(tokenCalls()).toHaveLength(1);
  });

  test('on, but stripePaymentLinks: false still means no Stripe decoration', async () => {
    const a = addLink('https://buy.stripe.com/test_1');
    await boot({ visitorToken: { stripe: true }, stripePaymentLinks: false });
    expect(a.getAttribute('href')).toBe('https://buy.stripe.com/test_1');
    expect(tokenCalls()).toHaveLength(0);
  });

  test("reset(): stamped links get the new visitor's token", async () => {
    const a = addLink('https://buy.stripe.com/test_1');
    const sdk = await boot({ visitorToken: { stripe: true } });
    await settle();
    sdk.reset();
    await settle();
    expect(new URL(a.href).searchParams.get('client_reference_id')).toBe(T2);
  });
});
