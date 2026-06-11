/**
 * D1 — Stripe Payment Link auto-decoration (syncStripePaymentLinks).
 *
 * The method is private on the Datalyr class and normally runs inside
 * initializeAsync(); full init() drags in network/container/encryption, so —
 * matching the repo's per-module test style — we drive the private method
 * directly on the exported singleton with its collaborators stubbed
 * (identity / config / userProperties / queue are all the method touches).
 */
import { datalyr } from './index';

const sdk = datalyr as any;

const VID = 'anon_0b815a3e6f9d4c2e8a7b1c3d5e7f9a0b';

type SetupOpts = {
  vid?: string | null;
  email?: string;
  privacyMode?: 'standard' | 'strict';
  extraDomains?: string[];
};

function setup(opts: SetupOpts = {}): { flush: jest.Mock } {
  sdk.config = { privacyMode: opts.privacyMode ?? 'standard', debug: false };
  sdk.identity = {
    getAnonymousId: () => (opts.vid === undefined ? VID : opts.vid),
  };
  sdk.userProperties = opts.email ? { email: opts.email } : {};
  const queue = { flush: jest.fn() };
  sdk.queue = queue;
  sdk.syncStripePaymentLinks(opts.extraDomains ?? []);
  return queue;
}

function addLink(href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  document.body.appendChild(a);
  return a;
}

// jsdom doesn't implement navigation; cancel anchor activation so click
// dispatch in tests doesn't log "Not implemented: navigation".
const cancelNav = (e: Event) => e.preventDefault();
beforeAll(() => document.addEventListener('click', cancelNav));
afterAll(() => document.removeEventListener('click', cancelNav));

afterEach(() => {
  // Tear down the observer + capture-phase click listener between tests.
  sdk.stripeLinksDisposer?.();
  sdk.stripeLinksDisposer = undefined;
  document.body.innerHTML = '';
});

describe('syncStripePaymentLinks — anchor stamping', () => {
  it('stamps client_reference_id on buy.stripe.com links, preserving query + hash', () => {
    const a = addLink('https://buy.stripe.com/test_abc?utm_source=t#frag');
    setup();
    const u = new URL(a.href);
    expect(u.searchParams.get('client_reference_id')).toBe(VID);
    expect(u.searchParams.get('utm_source')).toBe('t');
    expect(u.hash).toBe('#frag');
  });

  it('does NOT decorate checkout.stripe.com session URLs', () => {
    const a = addLink('https://checkout.stripe.com/c/pay/cs_test_123');
    setup();
    expect(a.href).not.toContain('client_reference_id');
  });

  it('matches exact host only — not path substrings or subdomains', () => {
    const evil = addLink('https://evil.com/buy.stripe.com/x');
    const sub = addLink('https://buy.stripe.com.evil.com/x');
    setup();
    expect(evil.href).not.toContain('client_reference_id');
    expect(sub.href).not.toContain('client_reference_id');
  });

  it('leaves a merchant-set client_reference_id untouched (no double-append)', () => {
    const a = addLink('https://buy.stripe.com/test_abc?client_reference_id=KEEP');
    setup();
    const u = new URL(a.href);
    expect(u.searchParams.getAll('client_reference_id')).toEqual(['KEEP']);
  });

  it('is idempotent across re-stamp passes', () => {
    const a = addLink('https://buy.stripe.com/test_abc');
    setup();
    const once = a.href;
    sdk.stripeLinksDisposer?.(); // don't leak the first observer/listener
    sdk.syncStripePaymentLinks([]); // simulate a second stampAll pass
    expect(a.href).toBe(once);
    expect(new URL(a.href).searchParams.getAll('client_reference_id')).toEqual([VID]);
  });

  it('skips silently when the visitor id fails the Stripe format guard', () => {
    const a = addLink('https://buy.stripe.com/test_abc');
    setup({ vid: 'anon_bad!value' });
    expect(a.href).not.toContain('client_reference_id');
    sdk.stripeLinksDisposer?.(); // don't leak the first observer/listener
    const b = addLink('https://buy.stripe.com/test_abc');
    setup({ vid: null });
    expect(b.href).not.toContain('client_reference_id');
  });

  it('decorates configured custom payment-link domains', () => {
    const a = addLink('https://pay.example.com/b/live_xyz');
    setup({ extraDomains: ['Pay.Example.com'] });
    expect(new URL(a.href).searchParams.get('client_reference_id')).toBe(VID);
  });
});

describe('syncStripePaymentLinks — prefilled_email', () => {
  it('stamps prefilled_email for identified users (percent-encoded)', () => {
    const a = addLink('https://buy.stripe.com/test_abc');
    setup({ email: 'jo+vip@example.com' });
    const u = new URL(a.href);
    expect(u.searchParams.get('prefilled_email')).toBe('jo+vip@example.com');
    expect(a.href).toContain('jo%2Bvip%40example.com');
  });

  it('does not stamp email when unidentified', () => {
    const a = addLink('https://buy.stripe.com/test_abc');
    setup();
    expect(a.href).not.toContain('prefilled_email');
  });

  it('does not stamp email under privacyMode strict', () => {
    const a = addLink('https://buy.stripe.com/test_abc');
    setup({ email: 'jo@example.com', privacyMode: 'strict' });
    expect(a.href).not.toContain('prefilled_email');
    // client_reference_id still stamps — only the email is privacy-gated.
    expect(new URL(a.href).searchParams.get('client_reference_id')).toBe(VID);
  });

  it('respects existing prefilled_email and locked_prefilled_email', () => {
    const pre = addLink('https://buy.stripe.com/x?prefilled_email=keep%40x.com');
    const locked = addLink('https://buy.stripe.com/x?locked_prefilled_email=lock%40x.com');
    setup({ email: 'jo@example.com' });
    expect(new URL(pre.href).searchParams.get('prefilled_email')).toBe('keep@x.com');
    expect(new URL(locked.href).searchParams.get('prefilled_email')).toBeNull();
  });
});

describe('syncStripePaymentLinks — embeds', () => {
  it('sets client-reference-id on stripe-pricing-table / stripe-buy-button if absent', () => {
    const table = document.createElement('stripe-pricing-table');
    const button = document.createElement('stripe-buy-button');
    const preset = document.createElement('stripe-pricing-table');
    preset.setAttribute('client-reference-id', 'KEEP');
    document.body.append(table, button, preset);
    setup();
    expect(table.getAttribute('client-reference-id')).toBe(VID);
    expect(button.getAttribute('client-reference-id')).toBe(VID);
    expect(preset.getAttribute('client-reference-id')).toBe('KEEP');
  });
});

describe('syncStripePaymentLinks — dynamic links + click handler', () => {
  it('stamps SPA-injected links via the debounced MutationObserver', async () => {
    setup();
    const late = addLink('https://buy.stripe.com/test_late');
    expect(late.href).not.toContain('client_reference_id');
    await new Promise((r) => setTimeout(r, 300)); // > 150ms debounce
    expect(new URL(late.href).searchParams.get('client_reference_id')).toBe(VID);
  });

  it('re-stamps on capture-phase click (post-init identify) and flushes the queue', () => {
    const a = addLink('https://buy.stripe.com/test_abc');
    const queue = setup();
    // identify() happens after init — email only exists at click time.
    sdk.userProperties = { email: 'late@example.com' };
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const u = new URL(a.href);
    expect(u.searchParams.get('client_reference_id')).toBe(VID);
    expect(u.searchParams.get('prefilled_email')).toBe('late@example.com');
    expect(queue.flush).toHaveBeenCalled();
  });

  it('ignores clicks on non-payment-link anchors (no flush)', () => {
    const a = addLink('https://example.com/pricing');
    const queue = setup();
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(a.href).not.toContain('client_reference_id');
    expect(queue.flush).not.toHaveBeenCalled();
  });

  it('disposer removes the click listener and observer', async () => {
    const queue = setup();
    sdk.stripeLinksDisposer();
    const a = addLink('https://buy.stripe.com/test_abc');
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(queue.flush).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 300));
    expect(a.href).not.toContain('client_reference_id');
  });
});
