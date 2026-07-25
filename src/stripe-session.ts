/**
 * Stripe Checkout Session capture.
 *
 * WHY THIS EXISTS
 * syncStripePaymentLinks stamps `client_reference_id` onto buy.stripe.com
 * anchors, and deliberately never onto checkout.stripe.com — a Checkout Session
 * URL ignores the param because the session already exists server-side. That
 * leaves the single most common SaaS pattern uncovered: the merchant's backend
 * creates a Session and the browser is sent to checkout.stripe.com/c/pay/cs_...
 * The payment then reaches our webhook with no visitor at all.
 *
 * Measured 2026-07-25, 30d: of payers arriving via Stripe webhooks, 0.5% (one
 * tenant, 128/28,187) and 13.3% (another, 13/98) had ANY web pageview on the
 * same visitor. Not a misconfiguration — no tenant is wired, because being
 * wired currently requires the merchant to hand-write client_reference_id.
 *
 * WHAT THIS DOES
 * The session id must reach the browser for the redirect to happen at all, so
 * we observe it rather than trying to inject anything:
 *   1. fetch/XHR response bodies      — `{url}` or `{sessionId}` from the
 *                                       merchant's own create-session endpoint
 *   2. anchor clicks + window.open    — direct links to checkout.stripe.com
 * A server-side 302 straight to Stripe never exposes the id to JS and is NOT
 * covered here; that case falls back to the email bridge.
 *
 * WHY THIS IS SAFE TO DEFAULT ON, WHEN autoIdentifyAPI IS NOT
 * autoIdentifyAPI scans the same traffic for EMAILS, which is why it defaults
 * off: an admin viewing a customer record gets identified as that customer, and
 * a wrong email propagates into Meta advanced matching. A `cs_live_...` token is
 * unambiguous, belongs to exactly one checkout, and is not PII. There is no
 * mis-identification failure mode to guard against — only the wrapper itself,
 * which is why every hook below is transparent and failure-isolated.
 */

/** Stripe Checkout Session ids: cs_live_… / cs_test_… */
const SESSION_ID_RE = /cs_(?:live|test)_[A-Za-z0-9]{8,}/;

/** Hosts whose URLs carry a session id in the path. Exact match, never substring. */
const CHECKOUT_HOSTS = new Set(['checkout.stripe.com']);

/**
 * Response bodies are scanned in full, so cap what we're willing to read. A
 * create-session response is a few hundred bytes; anything large is not it, and
 * reading it would cost the merchant's page real memory and main-thread time.
 */
const MAX_SCAN_BYTES = 65536;

/** Bodies worth scanning. Stripe ids arrive as JSON or text, never as binary. */
const SCANNABLE_TYPE_RE = /(json|text|javascript)/i;

export type StripeSessionSink = (sessionId: string) => void;

export interface StripeSessionWatcherOptions {
  /** Emit at most this many distinct session ids per page. */
  maxSessions?: number;
  /** Test seam. */
  maxScanBytes?: number;
}

export function extractSessionId(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = SESSION_ID_RE.exec(text);
  return m ? m[0] : null;
}

/**
 * True when `href` points at a Stripe-hosted checkout. Uses the URL API and
 * exact host equality — `a[href*="checkout.stripe.com"]` would match
 * `evil.com/checkout.stripe.com/x` and `checkout.stripe.com.evil.com`.
 */
export function isCheckoutUrl(href: string, base?: string): boolean {
  try {
    const host = new URL(
      href,
      base ?? (typeof window !== 'undefined' ? window.location.href : undefined),
    ).hostname.toLowerCase();
    return CHECKOUT_HOSTS.has(host);
  } catch {
    return false;
  }
}

export class StripeSessionWatcher {
  private sink?: StripeSessionSink;
  private seen = new Set<string>();
  private disposers: Array<() => void> = [];
  private started = false;
  private readonly maxSessions: number;
  private readonly maxScanBytes: number;

  constructor(options: StripeSessionWatcherOptions = {}) {
    this.maxSessions = options.maxSessions ?? 5;
    this.maxScanBytes = options.maxScanBytes ?? MAX_SCAN_BYTES;
  }

  start(sink: StripeSessionSink): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.sink = sink;
    this.hookFetch();
    this.hookXhr();
    this.hookClicks();
    this.hookWindowOpen();
  }

  stop(): void {
    // Restore in reverse so a later wrapper never re-installs an earlier one.
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* idempotent */
      }
    }
    this.disposers = [];
    this.started = false;
    this.sink = undefined;
  }

  /** Report a session id at most once, and never more than maxSessions per page. */
  private emit(sessionId: string | null): void {
    if (!sessionId || this.seen.has(sessionId)) return;
    if (this.seen.size >= this.maxSessions) return;
    this.seen.add(sessionId);
    try {
      this.sink?.(sessionId);
    } catch {
      // A throwing sink must never surface inside the merchant's fetch chain.
    }
  }

  /**
   * Scan a Response WITHOUT disturbing the merchant's own read. `clone()` must
   * happen synchronously, before the caller can consume the body; the read of
   * the clone is deliberately not awaited by the caller.
   */
  private scanResponse(response: Response): void {
    try {
      const type = response.headers?.get?.('content-type') ?? '';
      if (type && !SCANNABLE_TYPE_RE.test(type)) return;
      const declared = Number(response.headers?.get?.('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > this.maxScanBytes) return;
      const clone = typeof response.clone === 'function' ? response.clone() : null;
      if (!clone) return;
      void clone
        .text()
        .then((body) => this.emit(extractSessionId(body.slice(0, this.maxScanBytes))))
        .catch(() => {
          /* body already disturbed / opaque response — nothing to do */
        });
    } catch {
      /* never let observation break the request */
    }
  }

  private hookFetch(): void {
    if (typeof window.fetch !== 'function') return;
    const original = window.fetch;
    const self = this;
    const patched = function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
      const result = original.apply(this ?? window, args);
      try {
        // Attach passively: the merchant still gets the original promise, and a
        // rejection here is theirs to handle, not ours to observe twice.
        result.then((response) => self.scanResponse(response)).catch(() => {});
      } catch {
        /* ignore */
      }
      return result;
    } as typeof window.fetch;
    window.fetch = patched;
    this.disposers.push(() => {
      // Only restore if nobody wrapped us afterwards — clobbering a later
      // wrapper would silently disable whatever installed it.
      if (window.fetch === patched) window.fetch = original;
    });
  }

  private hookXhr(): void {
    if (typeof XMLHttpRequest === 'undefined') return;
    const proto = XMLHttpRequest.prototype;
    const originalSend = proto.send;
    if (typeof originalSend !== 'function') return;
    const self = this;
    const patched = function patchedSend(this: XMLHttpRequest, ...args: unknown[]) {
      try {
        this.addEventListener('load', () => {
          try {
            // responseText throws for blob/arraybuffer response types.
            if (this.responseType !== '' && this.responseType !== 'text') return;
            const body = this.responseText;
            if (!body || body.length > self.maxScanBytes) return;
            self.emit(extractSessionId(body));
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, args as []);
    } as typeof proto.send;
    proto.send = patched;
    this.disposers.push(() => {
      if (proto.send === patched) proto.send = originalSend;
    });
  }

  /**
   * Direct links to checkout.stripe.com. Capture phase so we still see the click
   * when the merchant's own handler calls stopPropagation().
   */
  private hookClicks(): void {
    if (typeof document === 'undefined') return;
    const onClick = (e: Event) => {
      try {
        const target = (e.target as Element | null)?.closest?.('a[href]') as
          | HTMLAnchorElement
          | null;
        if (!target || !target.href || !isCheckoutUrl(target.href)) return;
        this.emit(extractSessionId(target.href));
      } catch {
        /* never block navigation */
      }
    };
    document.addEventListener('click', onClick, true);
    this.disposers.push(() => document.removeEventListener('click', onClick, true));
  }

  private hookWindowOpen(): void {
    if (typeof window.open !== 'function') return;
    const original = window.open;
    const self = this;
    const patched = function patchedOpen(this: unknown, ...args: Parameters<typeof window.open>) {
      try {
        const url = args[0];
        const href = typeof url === 'string' ? url : url?.toString?.();
        if (href && isCheckoutUrl(href)) self.emit(extractSessionId(href));
      } catch {
        /* ignore */
      }
      return original.apply(this ?? window, args);
    } as typeof window.open;
    window.open = patched;
    this.disposers.push(() => {
      if (window.open === patched) window.open = original;
    });
  }
}
