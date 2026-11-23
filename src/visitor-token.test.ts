/**
 * FX-083 signed visitor token, script side: the token client and the link decorator.
 */
import {
  TokenLinkDecorator,
  VisitorTokenClient,
  VISITOR_TOKEN_KEY,
  VISITOR_TOKEN_REFRESH_MS,
  anyTokenEnabled,
  rawIdsAccepted,
  tokenEnabled,
  type TokenLinkRule,
} from './visitor-token';

const VID = 'anon_0b815a3e-6f9d-4c2e-8a7b-1c3d5e7f9a0b';
const VID2 = 'anon_1c926b4f-7a0e-4d3f-9b8c-2d4e6f8a0b1c';
const tok = (c: string): string => 'dv1' + c.repeat(54);
const T1 = tok('A');
const T2 = tok('B');
const T3 = tok('C');

let visitorId: string | null = VID;
let allowed = true;
let fetchMock: jest.Mock;
let tokens: string[];

function mockFetch(): jest.Mock {
  fetchMock = jest.fn(async () => {
    const token = tokens.shift();
    return token
      ? { ok: true, status: 200, json: async () => ({ token, expires_in: 7200 }) }
      : { ok: false, status: 500, json: async () => ({}) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function client(endpoint = 'https://ingest.datalyr.com'): VisitorTokenClient {
  return new VisitorTokenClient({
    endpoint,
    workspaceId: 'ws_1',
    getVisitorId: () => visitorId,
    allowed: () => allowed,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const originalFetch = global.fetch;
beforeEach(() => {
  visitorId = VID;
  allowed = true;
  tokens = [T1, T2, T3];
  mockFetch();
  sessionStorage.clear();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  document.body.innerHTML = '';
});

describe('settings', () => {
  it('everything is off unless a provider is exactly true', () => {
    expect(anyTokenEnabled(undefined)).toBe(false);
    expect(anyTokenEnabled({})).toBe(false);
    expect(anyTokenEnabled({ stripe: 'true' })).toBe(false);
    expect(anyTokenEnabled({ rawIdFallback: true })).toBe(false);
    expect(tokenEnabled({ calendly: true }, 'calendly')).toBe(true);
    expect(tokenEnabled({ calendly: true }, 'stripe')).toBe(false);
    expect(rawIdsAccepted(undefined)).toBe(true);
    expect(rawIdsAccepted({ rawIdFallback: false })).toBe(false);
  });
});

describe('VisitorTokenClient', () => {
  it('asks POST <endpoint>/v1/visitor-token with the workspace and visitor, and X-DL-Consent', async () => {
    const c = client('https://ingest.datalyr.com/');
    await expect(c.get()).resolves.toBe(T1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ingest.datalyr.com/v1/visitor-token');
    expect(init.method).toBe('POST');
    expect(init.headers['X-DL-Consent']).toBe('granted');
    expect(JSON.parse(init.body)).toEqual({ workspace_id: 'ws_1', visitor_id: VID });
    expect(init.credentials).toBe('omit');
  });

  it('sends cookies only to a first-party (own domain) endpoint', async () => {
    await client('https://t.shop.example').get();
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('caches in memory and sessionStorage dl_vt; a second get makes no request', async () => {
    const c = client();
    await c.get();
    await expect(c.get()).resolves.toBe(T1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(sessionStorage.getItem(VISITOR_TOKEN_KEY) as string);
    expect(stored.t).toBe(T1);
    expect(stored.v).toBe(VID);
    // A new page (new client) reads the session copy.
    expect(client().peek()).toBe(T1);
  });

  it('one request for concurrent callers', async () => {
    const c = client();
    const [a, b] = await Promise.all([c.get(), c.get()]);
    expect(a).toBe(T1);
    expect(b).toBe(T1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renews after 15 minutes; an expired token is never handed out', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['queueMicrotask'] });
    const c = client();
    await c.get();
    jest.setSystemTime(Date.now() + VISITOR_TOKEN_REFRESH_MS + 1);
    expect(c.peek()).toBe(T1); // still valid, only no longer fresh
    await expect(c.get()).resolves.toBe(T2);
    jest.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect(c.peek()).toBeNull();
    expect(sessionStorage.getItem(VISITOR_TOKEN_KEY)).toBeNull();
  });

  it('never asks while consent or tracking says no', async () => {
    allowed = false;
    const c = client();
    await expect(c.get()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only for anon_<uuid> ids the script made', async () => {
    for (const id of ['user@example.com', 'anon_123', 'custom-visitor', '']) {
      visitorId = id;
      await expect(client().get()).resolves.toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a token cached for another visitor is dropped', async () => {
    const c = client();
    await c.get();
    visitorId = VID2;
    expect(c.peek()).toBeNull();
    await expect(c.get()).resolves.toBe(T2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).visitor_id).toBe(VID2);
  });

  it('clear() forgets the token and drops an answer still in flight', async () => {
    const c = client();
    const pending = c.get();
    c.clear();
    await expect(pending).resolves.toBeNull();
    expect(c.peek()).toBeNull();
    await c.get();
    c.clear();
    expect(sessionStorage.getItem(VISITOR_TOKEN_KEY)).toBeNull();
    expect(c.peek()).toBeNull();
  });

  it('refuses a malformed token and does not retry for a minute after a failure', async () => {
    tokens = ['not-a-token' as string, T1];
    const c = client();
    await expect(c.get()).resolves.toBeNull();
    await expect(c.get()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never adopts a dl_vt from the page URL', async () => {
    window.history.replaceState(null, '', `/?dl_vt=${T3}`);
    try {
      const c = client();
      expect(c.peek()).toBeNull();
      await expect(c.get()).resolves.toBe(T1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).visitor_id).toBe(VID);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('TokenLinkDecorator', () => {
  const rules: TokenLinkRule[] = [
    {
      provider: 'stripe',
      param: 'client_reference_id',
      matchHost: (h) => h === 'buy.stripe.com',
      embedSelector: 'stripe-pricing-table, stripe-buy-button',
      embedAttribute: 'client-reference-id',
    },
    { provider: 'calendly', param: 'salesforce_uuid', matchHost: (h) => h === 'calendly.com' || h.endsWith('.calendly.com') },
    { provider: 'iclosed', param: 'dl_vt', matchHost: (h) => h === 'iclosed.io' || h.endsWith('.iclosed.io') },
  ];
  let decorator: TokenLinkDecorator | undefined;
  let canDecorate = true;

  function add(html: string): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = html;
    const el = div.firstElementChild as HTMLElement;
    document.body.appendChild(el);
    return el;
  }

  function start(c = client()): TokenLinkDecorator {
    decorator = new TokenLinkDecorator({ rules, client: c, canDecorate: () => canDecorate });
    decorator.start();
    return decorator;
  }

  const cancelNav = (e: Event) => e.preventDefault();
  beforeAll(() => document.addEventListener('click', cancelNav));
  afterAll(() => document.removeEventListener('click', cancelNav));
  beforeEach(() => {
    canDecorate = true;
  });
  afterEach(() => {
    decorator?.stop(false);
    decorator = undefined;
  });

  it('no request on a page without a decoratable link', async () => {
    add('<a href="https://example.com/pricing">x</a>');
    start();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stamps Stripe, Calendly and iClosed links and embeds, keeping query and hash', async () => {
    const stripe = add('<a href="https://buy.stripe.com/test_1?utm_source=a#f">pay</a>');
    const cal = add('<a href="https://calendly.com/team/intro">book</a>');
    const calInline = add('<div class="calendly-inline-widget" data-url="https://calendly.com/team/demo"></div>');
    const ic = add('<iframe src="https://app.iclosed.io/e/team/call"></iframe>');
    const table = add('<stripe-pricing-table pricing-table-id="prctbl_1"></stripe-pricing-table>');
    start();
    await settle();
    const s = new URL(stripe.getAttribute('href') as string);
    expect(s.searchParams.get('client_reference_id')).toBe(T1);
    expect(s.searchParams.get('utm_source')).toBe('a');
    expect(s.hash).toBe('#f');
    expect(new URL(cal.getAttribute('href') as string).searchParams.get('salesforce_uuid')).toBe(T1);
    expect(new URL(calInline.getAttribute('data-url') as string).searchParams.get('salesforce_uuid')).toBe(T1);
    expect(new URL(ic.getAttribute('src') as string).searchParams.get('dl_vt')).toBe(T1);
    expect(table.getAttribute('client-reference-id')).toBe(T1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only empty fields: a value the site set is kept', async () => {
    const a = add('<a href="https://buy.stripe.com/test_1?client_reference_id=KEEP">pay</a>');
    const c = add('<a href="https://calendly.com/x?salesforce_uuid=OWN">book</a>');
    const t = add('<stripe-buy-button client-reference-id="MINE"></stripe-buy-button>');
    start();
    await settle();
    expect(new URL(a.getAttribute('href') as string).searchParams.getAll('client_reference_id')).toEqual(['KEEP']);
    expect(new URL(c.getAttribute('href') as string).searchParams.get('salesforce_uuid')).toBe('OWN');
    expect(t.getAttribute('client-reference-id')).toBe('MINE');
  });

  it('replaces a raw id an older stamp wrote; removing the token leaves the field empty', async () => {
    const raw = 'anon_0b815a3e-6f9d-4c2e-8a7b-1c3d5e7f9a0b';
    const withRaw: TokenLinkRule[] = [{ ...rules[0], replaceable: (v) => v === raw }];
    const a = add(`<a href="https://buy.stripe.com/test_1?client_reference_id=${raw}">pay</a>`);
    const t = add(`<stripe-buy-button client-reference-id="${raw}"></stripe-buy-button>`);
    decorator = new TokenLinkDecorator({ rules: withRaw, client: client(), canDecorate: () => true });
    decorator.start();
    await settle();
    expect(new URL(a.getAttribute('href') as string).searchParams.get('client_reference_id')).toBe(T1);
    expect(t.getAttribute('client-reference-id')).toBe(T1);
    decorator.stop(true);
    expect(a.getAttribute('href')).toBe('https://buy.stripe.com/test_1');
    expect(t.hasAttribute('client-reference-id')).toBe(false);
  });

  it('exact host only: no path substrings or look-alike hosts', async () => {
    const evil = add('<a href="https://evil.com/calendly.com/x">x</a>');
    const sub = add('<a href="https://calendly.com.evil.com/x">x</a>');
    start();
    await settle();
    expect(evil.getAttribute('href')).toBe('https://evil.com/calendly.com/x');
    expect(sub.getAttribute('href')).toBe('https://calendly.com.evil.com/x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-stamps on click with the newer token', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['queueMicrotask'] });
    const c = client();
    const a = add('<a href="https://buy.stripe.com/test_1">pay</a>');
    start(c);
    await settle();
    expect(new URL(a.getAttribute('href') as string).searchParams.get('client_reference_id')).toBe(T1);
    jest.setSystemTime(Date.now() + VISITOR_TOKEN_REFRESH_MS + 1);
    await c.get(); // a getter renewed it (T2)
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(new URL(a.getAttribute('href') as string).searchParams.get('client_reference_id')).toBe(T2);
  });

  it('renews every 15 minutes while a decoratable link is on the page', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['queueMicrotask'] });
    const a = add('<a href="https://calendly.com/team/intro">book</a>');
    start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(VISITOR_TOKEN_REFRESH_MS + 10);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(a.getAttribute('href') as string).searchParams.get('salesforce_uuid')).toBe(T2);
    // Link gone: no more requests.
    a.remove();
    jest.advanceTimersByTime(VISITOR_TOKEN_REFRESH_MS + 10);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('iframes are stamped once (rewriting src would reload the widget)', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['queueMicrotask'] });
    const ic = add('<iframe src="https://app.iclosed.io/e/team/call"></iframe>');
    start();
    await settle();
    const first = ic.getAttribute('src');
    jest.advanceTimersByTime(VISITOR_TOKEN_REFRESH_MS + 10);
    await settle();
    expect(ic.getAttribute('src')).toBe(first);
  });

  it('no token and no request without consent', async () => {
    canDecorate = false;
    allowed = false;
    const a = add('<a href="https://buy.stripe.com/test_1">pay</a>');
    start();
    await settle();
    expect(a.getAttribute('href')).toBe('https://buy.stripe.com/test_1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stop(true) puts every stamped link back exactly as it was', async () => {
    const a = add('<a href="https://buy.stripe.com/test_1?x=1">pay</a>');
    const t = add('<stripe-buy-button buy-button-id="b"></stripe-buy-button>');
    const d = add('<div data-url="https://calendly.com/team/demo"></div>');
    start();
    await settle();
    expect(a.getAttribute('href')).toContain('client_reference_id=');
    decorator!.stop(true);
    expect(a.getAttribute('href')).toBe('https://buy.stripe.com/test_1?x=1');
    expect(t.hasAttribute('client-reference-id')).toBe(false);
    expect(d.getAttribute('data-url')).toBe('https://calendly.com/team/demo');
    // Stopped: a later link is not stamped.
    const later = add('<a href="https://buy.stripe.com/test_2">pay</a>');
    await new Promise((r) => setTimeout(r, 200));
    expect(later.getAttribute('href')).toBe('https://buy.stripe.com/test_2');
  });

  it('stop(true) takes only our token out of a link the site rewrote after stamping', async () => {
    const a = add('<a href="https://buy.stripe.com/test_1">pay</a>');
    start();
    await settle();
    const u = new URL(a.getAttribute('href') as string);
    u.searchParams.set('prefilled_email', 'a@b.co');
    a.setAttribute('href', u.toString());
    decorator!.stop(true);
    const after = new URL(a.getAttribute('href') as string);
    expect(after.searchParams.has('client_reference_id')).toBe(false);
    expect(after.searchParams.get('prefilled_email')).toBe('a@b.co');
  });

  it("reissue() replaces the old visitor's token with the new visitor's", async () => {
    const c = client();
    const a = add('<a href="https://buy.stripe.com/test_1">pay</a>');
    start(c);
    await settle();
    visitorId = VID2;
    c.clear();
    decorator!.reissue();
    await settle();
    expect(new URL(a.getAttribute('href') as string).searchParams.get('client_reference_id')).toBe(T2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).visitor_id).toBe(VID2);
  });
});
