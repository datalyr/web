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

function callsTo(path: string): any[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(path));
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
  autoIdentify: false,
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
  document.cookie = '__dl_visitor_id=; domain=localhost; path=/; max-age=0';
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

describe('C14: getStripeMetadata() / getWhopCheckoutMetadata() return the token', () => {
  test('before the token is ready: the raw id, and the call starts the request', async () => {
    const sdk = await boot({ visitorToken: { stripe: true, whop: true } });
    const vid = sdk.getVisitorId();
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: vid, metadata: { visitor_id: vid } });
    expect(sdk.getWhopCheckoutMetadata()).toEqual({ visitor_id: vid });
    await settle();
    expect(tokenCalls()).toHaveLength(1);
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: T1, metadata: { visitor_id: vid, dl_vt: T1 } });
    expect(sdk.getWhopCheckoutMetadata()).toEqual({ visitor_id: vid, dl_vt: T1 });
  });

  test('raw ids retired (rawIdFallback: false): empty until the token is ready', async () => {
    const sdk = await boot({ visitorToken: { stripe: true, whop: true, rawIdFallback: false } });
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: '', metadata: { visitor_id: '' } });
    expect(sdk.getWhopCheckoutMetadata()).toEqual({ visitor_id: '' });
    await sdk.getVisitorToken();
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: T1, metadata: { visitor_id: '', dl_vt: T1 } });
    expect(sdk.getWhopCheckoutMetadata()).toEqual({ visitor_id: '', dl_vt: T1 });
  });

  test('only the provider switched on changes', async () => {
    const sdk = await boot({ visitorToken: { whop: true } });
    await sdk.getVisitorToken();
    const vid = sdk.getVisitorId();
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: vid, metadata: { visitor_id: vid } });
    expect(sdk.getWhopCheckoutMetadata()).toEqual({ visitor_id: vid, dl_vt: T1 });
  });

  test('consent denied: the getters fall back and nothing is requested', async () => {
    const sdk = await boot({ visitorToken: { stripe: true } });
    sdk.setConsent({ marketing: false });
    const vid = sdk.getVisitorId();
    expect(sdk.getStripeMetadata()).toEqual({ client_reference_id: vid, metadata: { visitor_id: vid } });
    await settle();
    expect(tokenCalls()).toHaveLength(0);
  });
});

describe('C15: Calendly and iClosed links and embeds', () => {
  function addEl(html: string): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = html;
    const el = div.firstElementChild as HTMLElement;
    document.body.appendChild(el);
    return el;
  }

  test('off: untouched, no request', async () => {
    const cal = addLink('https://calendly.com/team/intro');
    const ic = addLink('https://app.iclosed.io/e/team/call');
    await boot({ visitorToken: { stripe: true } });
    expect(cal.getAttribute('href')).toBe('https://calendly.com/team/intro');
    expect(ic.getAttribute('href')).toBe('https://app.iclosed.io/e/team/call');
    expect(tokenCalls()).toHaveLength(0);
  });

  test('on: salesforce_uuid on Calendly, dl_vt on iClosed, only when empty', async () => {
    const cal = addLink('https://calendly.com/team/intro?month=2026-12');
    const calOwn = addLink('https://calendly.com/team/other?salesforce_uuid=OWN');
    const calInline = addEl('<div class="calendly-inline-widget" data-url="https://calendly.com/team/demo"></div>');
    const ic = addLink('https://app.iclosed.io/e/team/call');
    const icFrame = addEl('<iframe src="https://app.iclosed.io/e/team/embed"></iframe>');
    const stripe = addLink('https://buy.stripe.com/test_1');
    const sdk = await boot({ visitorToken: { calendly: true, iclosed: true } });
    await settle();
    expect(new URL(cal.href).searchParams.get('salesforce_uuid')).toBe(T1);
    expect(new URL(cal.href).searchParams.get('month')).toBe('2026-12');
    expect(new URL(calOwn.href).searchParams.get('salesforce_uuid')).toBe('OWN');
    expect(new URL(calInline.getAttribute('data-url') as string).searchParams.get('salesforce_uuid')).toBe(T1);
    expect(new URL(ic.href).searchParams.get('dl_vt')).toBe(T1);
    expect(new URL(icFrame.getAttribute('src') as string).searchParams.get('dl_vt')).toBe(T1);
    // Stripe stays on the raw id: its own switch is off.
    expect(new URL(stripe.href).searchParams.get('client_reference_id')).toBe(sdk.getVisitorId());
    expect(tokenCalls()).toHaveLength(1);
  });
});

describe('C16: CheckoutChamp outbound links carry dl_vt', () => {
  test('off: links to the funnel are untouched (the raw bridge stays off)', async () => {
    const a = addLink('https://checkout.brand.example/step1');
    await boot({ checkoutChampDomains: ['checkout.brand.example'] });
    expect(a.getAttribute('href')).toBe('https://checkout.brand.example/step1');
    expect(tokenCalls()).toHaveLength(0);
  });

  test('on: dl_vt only on links to the listed domains', async () => {
    const funnel = addLink('https://checkout.brand.example/step1?aff=1');
    const sub = addLink('https://www.checkout.brand.example/step1');
    const other = addLink('https://brand.example/about');
    const own = addLink('https://checkout.brand.example/step2?dl_vt=SET');
    await boot({ checkoutChampDomains: ['https://checkout.brand.example/'], visitorToken: { checkoutchamp: true } });
    await settle();
    expect(new URL(funnel.href).searchParams.get('dl_vt')).toBe(T1);
    expect(new URL(funnel.href).searchParams.get('aff')).toBe('1');
    expect(new URL(sub.href).searchParams.get('dl_vt')).toBe(T1);
    expect(other.getAttribute('href')).toBe('https://brand.example/about');
    expect(new URL(own.href).searchParams.get('dl_vt')).toBe('SET');
    expect(funnel.href).not.toContain('_dl_vid');
  });

  test('on, but no checkoutChampDomains: nothing', async () => {
    const a = addLink('https://checkout.brand.example/step1');
    await boot({ visitorToken: { checkoutchamp: true } });
    expect(a.getAttribute('href')).toBe('https://checkout.brand.example/step1');
    expect(tokenCalls()).toHaveLength(0);
  });
});

describe('C18: consent signal for first-party requests', () => {
  test('off: no signal', async () => {
    const sdk = await boot({ endpoint: 'https://t.shop.example' });
    expect(sdk.consentSignal()).toBeNull();
  });

  test('on: granted, then denied after a marketing withdrawal or opt-out', async () => {
    const sdk = await boot({ endpoint: 'https://t.shop.example', consentHeader: true });
    expect(sdk.consentSignal()).toBe('granted');
    sdk.setConsent({ marketing: false });
    expect(sdk.consentSignal()).toBe('denied');
    sdk.setConsent({ marketing: true });
    expect(sdk.consentSignal()).toBe('granted');
    sdk.optOut();
    expect(sdk.consentSignal()).toBe('denied');
  });
});

describe('C19 (script side): opt-out and consent withdrawal', () => {
  test('optOut(): stamped links go back to their original href, the token is forgotten', async () => {
    const stripe = addLink('https://buy.stripe.com/test_1?x=1');
    const cal = addLink('https://calendly.com/team/intro');
    const sdk = await boot({ visitorToken: { stripe: true, calendly: true } });
    await settle();
    expect(stripe.getAttribute('href')).toContain('client_reference_id=');
    expect(sessionStorage.getItem('dl_vt')).not.toBeNull();
    sdk.optOut();
    expect(stripe.getAttribute('href')).toBe('https://buy.stripe.com/test_1?x=1');
    expect(cal.getAttribute('href')).toBe('https://calendly.com/team/intro');
    expect(sessionStorage.getItem('dl_vt')).toBeNull();
    await expect(sdk.getVisitorToken()).resolves.toBeNull();
    // A link added after the opt-out is not stamped.
    const later = addLink('https://calendly.com/team/later');
    await new Promise((r) => setTimeout(r, 200));
    expect(later.getAttribute('href')).toBe('https://calendly.com/team/later');
    expect(callsTo('/v/clear')).toHaveLength(0); // edgeCookieV2 off
  });

  test('marketing withdrawal strips the links too', async () => {
    const cal = addLink('https://calendly.com/team/intro');
    const sdk = await boot({ visitorToken: { calendly: true } });
    await settle();
    expect(cal.getAttribute('href')).toContain('salesforce_uuid=');
    sdk.setConsent({ marketing: false });
    expect(cal.getAttribute('href')).toBe('https://calendly.com/team/intro');
  });

  test('edgeCookieV2 on, own-domain endpoint: optOut() calls POST /v/clear once', async () => {
    const sdk = await boot({ endpoint: 'https://t.shop.example', edgeCookieV2: true });
    sdk.optOut();
    sdk.setConsent({ analytics: false });
    await settle();
    const calls = callsTo('/v/clear');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://t.shop.example/v/clear');
    expect(calls[0][1]).toEqual({ method: 'POST', credentials: 'include', keepalive: true });
  });

  test('edgeCookieV2 on, consent withdrawn: POST /v/clear', async () => {
    const sdk = await boot({ endpoint: 'https://t.shop.example', edgeCookieV2: true });
    sdk.setConsent({ marketing: false });
    await settle();
    expect(callsTo('/v/clear')).toHaveLength(1);
  });

  test('edgeCookieV2 on, DATALYR endpoint (no edge): no call', async () => {
    const sdk = await boot({ edgeCookieV2: true });
    sdk.optOut();
    await settle();
    expect(callsTo('/v/clear')).toHaveLength(0);
  });

  test('all off: optOut() and withdrawal make no new request', async () => {
    const sdk = await boot({ endpoint: 'https://t.shop.example' });
    const before = fetchMock.mock.calls.length;
    sdk.setConsent({ marketing: false });
    sdk.optOut();
    await settle();
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('C21: optOut() deletes the stored visitor id (optOutDeletesVisitorId)', () => {
  function storedIds(): { cookie: string | null; local: string | null } {
    const m = document.cookie.match(/(?:^|;\s*)__dl_visitor_id=([^;]*)/);
    return { cookie: m ? decodeURIComponent(m[1]) : null, local: localStorage.getItem('dl_dl_anonymous_id') };
  }

  test('off: the id is kept through opt-out and opt-in (today)', async () => {
    const sdk = await boot();
    const vid = sdk.getVisitorId();
    sdk.optOut();
    expect(sdk.getVisitorId()).toBe(vid);
    sdk.optIn();
    expect(sdk.getVisitorId()).toBe(vid);
  });

  test('on: cookie and storage copies are deleted; opting in again persists a new id', async () => {
    const sdk = await boot({ optOutDeletesVisitorId: true });
    const vid = sdk.getVisitorId();
    const before = storedIds();
    expect(before.cookie === vid || (before.local || '').includes(vid)).toBe(true);
    sdk.optOut();
    const gone = storedIds();
    expect(gone.cookie).toBeNull();
    expect(gone.local).toBeNull();
    const fresh = sdk.getVisitorId();
    expect(fresh).not.toBe(vid);
    expect(fresh).toMatch(/^anon_[0-9a-f-]{36}$/);
    sdk.optIn();
    const after = storedIds();
    expect(after.cookie === fresh || (after.local || '').includes(fresh)).toBe(true);
    expect(sdk.getVisitorId()).toBe(fresh);
  });
});
