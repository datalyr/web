/**
 * Stripe Checkout Session capture.
 *
 * The extraction is the easy half. What these tests actually defend is that the
 * hooks are INVISIBLE to the merchant's page: their fetch still resolves with a
 * readable body, their XHR still fires, a throwing sink never surfaces inside
 * their promise chain, and stop() puts everything back. A regression there
 * breaks a live checkout, which is strictly worse than missing attribution.
 */
import { StripeSessionWatcher, extractSessionId, isCheckoutUrl } from './stripe-session';

const SESSION = 'cs_live_a1B2c3D4e5F6g7H8i9J0';

function jsonResponse(body: unknown, type = 'application/json'): Response {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
    clone() {
      return jsonResponse(body, type);
    },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let watcher: StripeSessionWatcher;
let seen: string[];

// jsdom doesn't implement navigation; cancel anchor activation so click
// dispatch doesn't log "Not implemented: navigation".
const cancelNav = (e: Event) => e.preventDefault();
beforeAll(() => document.addEventListener('click', cancelNav));
afterAll(() => document.removeEventListener('click', cancelNav));

beforeEach(() => {
  seen = [];
  watcher = new StripeSessionWatcher();
});
afterEach(() => watcher.stop());

describe('extractSessionId', () => {
  it('finds live and test ids anywhere in a body', () => {
    expect(extractSessionId(JSON.stringify({ url: `https://checkout.stripe.com/c/pay/${SESSION}` }))).toBe(SESSION);
    expect(extractSessionId('{"sessionId":"cs_test_ZZZ99999999"}')).toBe('cs_test_ZZZ99999999');
  });

  it('does not match near-misses', () => {
    // A customer id, a too-short suffix, and prose that merely contains "cs_".
    expect(extractSessionId('cus_ABCDEFGHIJ')).toBeNull();
    expect(extractSessionId('cs_live_short')).toBeNull();
    expect(extractSessionId('')).toBeNull();
    expect(extractSessionId(null)).toBeNull();
  });
});

describe('isCheckoutUrl', () => {
  it('matches the host exactly, never as a substring', () => {
    const base = 'https://shop.example/';
    expect(isCheckoutUrl(`https://checkout.stripe.com/c/pay/${SESSION}`, base)).toBe(true);
    // Both of these would pass a naive a[href*="checkout.stripe.com"] selector.
    expect(isCheckoutUrl('https://evil.com/checkout.stripe.com/x', base)).toBe(false);
    expect(isCheckoutUrl('https://checkout.stripe.com.evil.com/x', base)).toBe(false);
    // buy.stripe.com is the Payment Link decorator's job, not ours.
    expect(isCheckoutUrl('https://buy.stripe.com/test_abc', base)).toBe(false);
  });
});

describe('fetch hook', () => {
  it('captures the session id from a create-session response', async () => {
    window.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ url: `https://checkout.stripe.com/c/pay/${SESSION}` }),
    ) as unknown as typeof fetch;
    watcher.start((id) => seen.push(id));

    await window.fetch('/api/checkout', { method: 'POST' });
    await flush();
    expect(seen).toEqual([SESSION]);
  });

  it('leaves the merchant response body readable', async () => {
    // The whole design rests on clone(): if we read the original body, the
    // merchant's own .json() rejects and their checkout dies.
    window.fetch = jest.fn().mockResolvedValue(jsonResponse({ sessionId: SESSION })) as unknown as typeof fetch;
    watcher.start((id) => seen.push(id));

    const response = await window.fetch('/api/checkout');
    await expect(response.json()).resolves.toEqual({ sessionId: SESSION });
    await flush();
    expect(seen).toEqual([SESSION]);
  });

  it('skips bodies that cannot carry a session id', async () => {
    window.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ url: `https://checkout.stripe.com/c/pay/${SESSION}` }, 'image/png'),
    ) as unknown as typeof fetch;
    watcher.start((id) => seen.push(id));

    await window.fetch('/img');
    await flush();
    expect(seen).toEqual([]);
  });

  it('propagates rejections untouched', async () => {
    const boom = new Error('network down');
    window.fetch = jest.fn().mockRejectedValue(boom) as unknown as typeof fetch;
    watcher.start((id) => seen.push(id));

    await expect(window.fetch('/api/checkout')).rejects.toThrow('network down');
  });

  it('survives a sink that throws', async () => {
    window.fetch = jest.fn().mockResolvedValue(jsonResponse({ sessionId: SESSION })) as unknown as typeof fetch;
    watcher.start(() => {
      throw new Error('sink exploded');
    });

    const response = await window.fetch('/api/checkout');
    await flush();
    await expect(response.json()).resolves.toEqual({ sessionId: SESSION });
  });

  it('restores the original fetch on stop()', async () => {
    const original = jest.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof fetch;
    window.fetch = original;
    watcher.start((id) => seen.push(id));
    expect(window.fetch).not.toBe(original);
    watcher.stop();
    expect(window.fetch).toBe(original);
  });

  it('does not clobber a wrapper installed after ours', () => {
    const original = jest.fn() as unknown as typeof fetch;
    window.fetch = original;
    watcher.start((id) => seen.push(id));
    // Someone else (another analytics tag) wraps fetch after we did.
    const foreign = jest.fn() as unknown as typeof fetch;
    window.fetch = foreign;
    watcher.stop();
    expect(window.fetch).toBe(foreign);
  });
});

describe('link and window.open hooks', () => {
  it('captures from a direct checkout link click', () => {
    watcher.start((id) => seen.push(id));
    const a = document.createElement('a');
    a.href = `https://checkout.stripe.com/c/pay/${SESSION}`;
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(seen).toEqual([SESSION]);
    document.body.innerHTML = '';
  });

  it('captures from window.open and still opens the window', () => {
    const original = jest.fn().mockReturnValue(null);
    window.open = original as unknown as typeof window.open;
    watcher.start((id) => seen.push(id));

    window.open(`https://checkout.stripe.com/c/pay/${SESSION}`, '_blank');
    expect(seen).toEqual([SESSION]);
    expect(original).toHaveBeenCalledTimes(1);
  });
});

describe('emission limits', () => {
  it('reports a given session id only once', async () => {
    window.fetch = jest.fn().mockResolvedValue(jsonResponse({ sessionId: SESSION })) as unknown as typeof fetch;
    watcher.start((id) => seen.push(id));
    // A polling create-session endpoint would otherwise emit on every call.
    await window.fetch('/api/checkout');
    await window.fetch('/api/checkout');
    await flush();
    expect(seen).toEqual([SESSION]);
  });

  it('caps distinct ids per page', async () => {
    const capped = new StripeSessionWatcher({ maxSessions: 2 });
    const ids: string[] = [];
    let n = 0;
    window.fetch = jest
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ sessionId: `cs_live_SESSION${n++}0000` })));
    capped.start((id) => ids.push(id));
    for (let i = 0; i < 5; i++) await window.fetch('/api/checkout');
    await flush();
    expect(ids).toHaveLength(2);
    capped.stop();
  });
});
