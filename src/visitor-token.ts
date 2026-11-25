/**
 * FX-083: signed visitor token, script side.
 *
 * A short, signed, expiring token that only DATALYR's servers can make. It is opaque to
 * the browser (the visitor id inside is encrypted): the script only checks it is a short
 * URL-safe string. It names this visit (device) for one workspace for 2 hours, so a
 * checkout or booking can find the visit that brought it without the raw visitor id
 * travelling in a link. The browser only asks for it and puts it on links; it never
 * reads one from a URL (an inbound `dl_vt` is never adopted as an identity).
 *
 * Everything here is inert unless a provider is switched on with the `visitorToken`
 * setting (`{ stripe, whop, calendly, iclosed, checkoutchamp }`, all off by default).
 */

import type { VisitorTokenSettings } from './types';

export type VisitorTokenProvider = keyof Omit<VisitorTokenSettings, 'rawIdFallback'>;

/** sessionStorage key for the cached token, and the URL parameter iClosed / CheckoutChamp read. */
export const VISITOR_TOKEN_KEY = 'dl_vt';
// sessionStorage flag: the mint route is not there (switch off, old ingest); stop asking.
const MINT_OFF_KEY = 'dl_vt_off';
/** While a decoratable link is on the page the token is renewed this often. */
export const VISITOR_TOKEN_REFRESH_MS = 15 * 60 * 1000;
/** Token life (owner answer 2): 2 hours, checked server-side at the provider's start time. */
export const VISITOR_TOKEN_LIFE_MS = 2 * 60 * 60 * 1000;
// A token this close to its expiry is not handed out any more.
const EXPIRY_MARGIN_MS = 60 * 1000;
// After a transient failure (network, 429, 5xx), wait this long before asking again.
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
// Tokens are minted by ingest; the customer's own-domain edge has no route for it.
export const DEFAULT_INGEST_ENDPOINT = 'https://ingest.datalyr.com';

/** The token is opaque: a short URL-safe string (Stripe's client_reference_id set). */
export const VISITOR_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Tokens are only minted for ids the script made itself (ingest: anon_<lowercase uuid>).
const MINTABLE_VISITOR_ID_RE = /^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function tokenEnabled(settings: unknown, provider: VisitorTokenProvider): boolean {
  return !!settings && typeof settings === 'object' && (settings as Record<string, unknown>)[provider] === true;
}

export function anyTokenEnabled(settings: unknown): boolean {
  return (['stripe', 'whop', 'calendly', 'iclosed', 'checkoutchamp'] as VisitorTokenProvider[])
    .some((p) => tokenEnabled(settings, p));
}

export function rawIdsAccepted(settings: unknown): boolean {
  return !(settings && typeof settings === 'object' && (settings as Record<string, unknown>).rawIdFallback === false);
}

/** The customer's own tracking host (edge), never *.datalyr.com. */
export function isFirstPartyEndpoint(endpoint: string): boolean {
  try {
    return !/(^|\.)datalyr\.com$/i.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

export function endpointUrl(endpoint: string, path: string): string {
  return endpoint.replace(/\/+$/, '') + path;
}

/** The ingest base the token is minted against: never the own-domain edge. */
export function mintBase(endpoint: string | undefined): string {
  return endpoint && !isFirstPartyEndpoint(endpoint) ? endpoint : DEFAULT_INGEST_ENDPOINT;
}

interface CachedToken {
  t: string; // token
  v: string; // visitor id it names
  i: number; // when this browser received it (ms)
  e: number; // when it stops being handed out (ms)
}

export interface VisitorTokenClientOptions {
  /** The configured event endpoint; minting always goes to ingest (mintBase). */
  endpoint: string;
  workspaceId: string;
  getVisitorId: () => string | null | undefined;
  /** Tracking allowed AND marketing consent not denied. Re-checked on every use. */
  allowed: () => boolean;
  /**
   * True while the visitor id is not settled yet (C19: the edge may still answer with the
   * id it kept): no token is minted or handed out for an id the server may never see.
   */
  waiting?: () => boolean;
}

function session(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

type MintResult = CachedToken | 'retry' | 'stop';

export class VisitorTokenClient {
  private cached: CachedToken | null = null;
  private inflight: Promise<string | null> | null = null;
  private generation = 0;
  private lastFailureAt = 0;
  private mintOff = false;

  constructor(private opts: VisitorTokenClientOptions) {
    try {
      this.mintOff = session()?.getItem(MINT_OFF_KEY) === '1';
    } catch {
      // blocked storage
    }
  }

  /** A token for the current visitor that has not expired, or null. Never calls the network. */
  peek(): string | null {
    if (!this.opts.allowed() || this.isWaiting()) return null;
    const cached = this.read();
    return cached ? cached.t : null;
  }

  /** True when a cached token exists and is younger than the refresh interval. */
  isFresh(): boolean {
    const cached = this.read();
    return !!cached && Date.now() - cached.i < VISITOR_TOKEN_REFRESH_MS;
  }

  /**
   * The current visitor's token: the cached one while it is younger than 15 minutes,
   * otherwise a new one from ingest's `POST /v1/visitor-token`. Null when tracking or
   * marketing consent is off, for a visitor id the script did not make, on failure, or
   * for the rest of the tab session once ingest showed it has no mint route.
   */
  get(): Promise<string | null> {
    if (!this.opts.allowed() || this.isWaiting()) return Promise.resolve(null);
    const visitorId = this.opts.getVisitorId();
    if (!visitorId || !MINTABLE_VISITOR_ID_RE.test(visitorId)) return Promise.resolve(null);
    const cached = this.read();
    if (cached && Date.now() - cached.i < VISITOR_TOKEN_REFRESH_MS) return Promise.resolve(cached.t);
    if (this.inflight) return this.inflight;
    if (this.mintOff || Date.now() - this.lastFailureAt < RETRY_AFTER_FAILURE_MS) {
      return Promise.resolve(cached ? cached.t : null);
    }
    const generation = this.generation;
    const request = this.mint(visitorId).then((result) => {
      if (result === 'stop') this.stopMinting();
      // reset(), opt-out or a withdrawal while the request was out: drop the answer.
      if (generation !== this.generation || !this.opts.allowed() || this.isWaiting() || this.opts.getVisitorId() !== visitorId) return null;
      if (result === 'stop' || result === 'retry') {
        if (result === 'retry') this.lastFailureAt = Date.now();
        const stillValid = this.read();
        return stillValid ? stillValid.t : null;
      }
      this.write(result);
      return result.t;
    });
    this.inflight = request;
    const done = (): void => {
      if (this.inflight === request) this.inflight = null;
    };
    request.then(done, done);
    return request;
  }

  /** Forget the cached token (memory and sessionStorage); answers still in flight are dropped. */
  clear(): void {
    this.generation += 1;
    this.cached = null;
    this.inflight = null;
    this.lastFailureAt = 0;
    try {
      session()?.removeItem(VISITOR_TOKEN_KEY);
    } catch {
      // blocked storage
    }
  }

  private isWaiting(): boolean {
    try {
      return !!this.opts.waiting?.();
    } catch {
      return false;
    }
  }

  private stopMinting(): void {
    this.mintOff = true;
    try {
      session()?.setItem(MINT_OFF_KEY, '1');
    } catch {
      // the memory flag still holds for this page
    }
  }

  private async mint(visitorId: string): Promise<MintResult> {
    let response: Response;
    try {
      if (typeof fetch !== 'function') return 'stop';
      // Consent goes in the body: ingest's preflight does not allow X-DL-Consent here.
      response = await fetch(endpointUrl(mintBase(this.opts.endpoint), '/v1/visitor-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: this.opts.workspaceId, visitor_id: visitorId, consent: 'granted' }),
        credentials: 'omit',
      });
    } catch {
      return 'retry'; // network
    }
    if (!response) return 'retry';
    if (response.status === 429 || response.status >= 500) return 'retry';
    if (!response.ok || response.status === 204) return 'stop'; // no route, refused, no key
    let body: any = null;
    try {
      body = await response.json();
    } catch {
      return 'stop'; // not JSON: not the mint route
    }
    const token = body && typeof body.token === 'string' ? body.token : null;
    if (!token || !VISITOR_TOKEN_RE.test(token)) return 'stop';
    const now = Date.now();
    const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
    const life = Number.isFinite(expiresAt) && expiresAt > now
      ? Math.min(expiresAt - now, VISITOR_TOKEN_LIFE_MS)
      : VISITOR_TOKEN_LIFE_MS;
    return { t: token, v: visitorId, i: now, e: now + life - EXPIRY_MARGIN_MS };
  }

  private read(): CachedToken | null {
    const visitorId = this.opts.getVisitorId();
    let cached = this.cached;
    if (!cached) {
      try {
        const raw = session()?.getItem(VISITOR_TOKEN_KEY);
        cached = raw ? JSON.parse(raw) : null;
      } catch {
        cached = null;
      }
    }
    const valid = !!cached && typeof cached.t === 'string' && VISITOR_TOKEN_RE.test(cached.t)
      && cached.v === visitorId && Number(cached.e) > Date.now() && Number(cached.i) <= Date.now();
    if (!valid) {
      if (cached) {
        // Another visitor's or an expired token: never hand it out again.
        this.cached = null;
        try {
          session()?.removeItem(VISITOR_TOKEN_KEY);
        } catch {
          // blocked storage
        }
      }
      return null;
    }
    this.cached = cached;
    return cached;
  }

  private write(cached: CachedToken): void {
    this.cached = cached;
    try {
      session()?.setItem(VISITOR_TOKEN_KEY, JSON.stringify(cached));
    } catch {
      // blocked or full storage: the memory copy still serves this page
    }
  }
}

/** One kind of link the decorator puts the token on. */
export interface TokenLinkRule {
  provider: VisitorTokenProvider;
  /** Query parameter that carries the token. */
  param: string;
  /** Hostname test (lower case). Exact-host or listed-subdomain matching only, never substrings. */
  matchHost: (host: string) => boolean;
  /** Custom elements whose whole attribute takes the token (Stripe pricing table / buy button). */
  embedSelector?: string;
  embedAttribute?: string;
  /**
   * A value already in the field that may be replaced anyway: the raw visitor id an
   * older stamp (the raw-id Stripe decorator) wrote. Removing the token later leaves
   * the field empty, never the raw id.
   */
  replaceable?: (value: string) => boolean;
}

interface StampRecord {
  param: string | null; // null for an embed attribute (the attribute IS the token)
  original: string | null;
  value: string; // the whole attribute value we wrote
  token: string; // the token inside it
  iframe: boolean;
}

// Element kinds whose URL attribute can carry the token. `refresh: false` for iframes:
// rewriting an iframe's src reloads the booking widget, so an iframe is stamped once.
const URL_TARGETS: ReadonlyArray<{ selector: string; attr: string; refresh: boolean }> = [
  { selector: 'a[href]', attr: 'href', refresh: true },
  { selector: '[data-url]', attr: 'data-url', refresh: true },
  { selector: 'iframe[src]', attr: 'src', refresh: false },
];

export interface TokenLinkDecoratorOptions {
  rules: TokenLinkRule[];
  client: VisitorTokenClient;
  /** Tracking allowed AND marketing consent not denied. Re-checked before every write. */
  canDecorate: () => boolean;
  /** Called after a click on a decorated link (the SDK flushes its queue). */
  onLinkClick?: () => void;
}

/**
 * Puts the token on checkout and booking links:
 *  - only in fields that are empty (a value the site set is never replaced);
 *  - re-stamped on click, renewed every 15 minutes while such a link is on the page;
 *  - each element's original attribute is kept (per attribute), so `stop(true)` puts
 *    every stamped link back exactly as it was (opt-out, consent withdrawal);
 *  - paused on `pagehide` and resumed when the page comes back from the back-forward cache.
 * No request is made on a page without a decoratable link.
 */
export class TokenLinkDecorator {
  private stamped = new Map<Element, Map<string, StampRecord>>();
  private observer?: MutationObserver;
  private restampTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<unknown> | null = null;
  private stopped = false;
  private paused = false;
  private readonly onClick = (e: Event): void => this.handleClick(e);
  private readonly onPageHide = (): void => this.pause();
  private readonly onPageShow = (e: Event): void => {
    if ((e as PageTransitionEvent).persisted) this.resume();
  };

  constructor(private opts: TokenLinkDecoratorOptions) {}

  start(): void {
    if (typeof document === 'undefined') return;
    this.arm();
    try {
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('pageshow', this.onPageShow);
    } catch {
      // best-effort
    }
  }

  /** Renew the token now if a decoratable link is on the page, then re-stamp. */
  refresh(): void {
    if (this.stopped || this.paused || !this.opts.canDecorate() || !this.hasCandidate()) return;
    this.fetchThenStamp();
  }

  /**
   * The visitor changed (reset(), an adopted edge id): put links back, then stamp the
   * new visitor's token once it is ready. Iframes are left alone (rewriting src reloads
   * the booking widget); they keep the earlier stamp.
   */
  reissue(): void {
    if (this.stopped) return;
    this.restoreAll(false);
    this.stampAll();
  }

  /** Stop decorating; with `strip`, put every link stamped on this page back as it was. */
  stop(strip: boolean): void {
    this.stopped = true;
    this.disarm();
    try {
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    } catch {
      // best-effort
    }
    if (strip) this.restoreAll(true);
  }

  /** Stamp every decoratable element; asks for a token when one is needed and missing. */
  stampAll(): void {
    if (this.stopped || this.paused || typeof document === 'undefined' || !this.opts.canDecorate()) return;
    const token = this.opts.client.peek();
    let found = false as boolean;
    this.forEachCandidate((el, attr, rule, refresh, whole) => {
      found = true;
      if (token) this.stamp(el, attr, rule, token, refresh, whole);
    });
    if (found && (!token || !this.opts.client.isFresh())) this.fetchThenStamp();
  }

  private arm(): void {
    this.paused = false;
    this.stampAll();
    document.addEventListener('click', this.onClick, true);
    try {
      this.observer = new MutationObserver(() => {
        if (this.restampTimer != null || this.stopped || this.paused) return;
        this.restampTimer = setTimeout(() => {
          this.restampTimer = null;
          this.stampAll();
        }, 150);
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      // no MutationObserver: the click-time stamp still covers links rendered later
    }
    this.refreshTimer = setInterval(() => this.refresh(), VISITOR_TOKEN_REFRESH_MS);
  }

  private disarm(): void {
    try { this.observer?.disconnect(); } catch { /* idempotent */ }
    this.observer = undefined;
    if (this.restampTimer != null) { clearTimeout(this.restampTimer); this.restampTimer = null; }
    if (this.refreshTimer != null) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (typeof document !== 'undefined') document.removeEventListener('click', this.onClick, true);
  }

  private pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.disarm();
  }

  private resume(): void {
    if (this.stopped || !this.paused) return;
    this.arm(); // the token may have aged in the cache: stampAll renews it
  }

  private fetchThenStamp(): void {
    if (this.pending) return;
    const request = this.opts.client.get().then((token) => {
      if (token) this.stampAll();
    }, () => undefined);
    this.pending = request;
    request.then(() => {
      if (this.pending === request) this.pending = null;
    });
  }

  private hasCandidate(): boolean {
    let found = false as boolean;
    this.forEachCandidate(() => { found = true; });
    return found;
  }

  private forEachCandidate(
    visit: (el: Element, attr: string, rule: TokenLinkRule, refresh: boolean, whole: boolean) => void,
  ): void {
    for (const target of URL_TARGETS) {
      document.querySelectorAll(target.selector).forEach((el) => {
        const rule = this.ruleFor(el.getAttribute(target.attr));
        if (rule) visit(el, target.attr, rule, target.refresh, false);
      });
    }
    for (const rule of this.opts.rules) {
      if (!rule.embedSelector || !rule.embedAttribute) continue;
      const attr = rule.embedAttribute;
      document.querySelectorAll(rule.embedSelector).forEach((el) => visit(el, attr, rule, true, true));
    }
  }

  private ruleFor(value: string | null): TokenLinkRule | null {
    if (!value) return null;
    let host: string;
    try {
      host = new URL(value, window.location.href).hostname.toLowerCase();
    } catch {
      return null;
    }
    for (const rule of this.opts.rules) {
      if (rule.matchHost(host)) return rule;
    }
    return null;
  }

  private record(el: Element, attr: string, rec: StampRecord): void {
    let byAttr = this.stamped.get(el);
    if (!byAttr) {
      byAttr = new Map();
      this.stamped.set(el, byAttr);
    }
    byAttr.set(attr, rec);
  }

  /** `whole`: an embed attribute that takes the whole token (not a URL parameter). */
  private stamp(el: Element, attr: string, rule: TokenLinkRule, token: string, refresh: boolean, whole: boolean): void {
    const current = el.getAttribute(attr);
    const record = this.stamped.get(el)?.get(attr);
    const ours = !!record && record.value === current;
    const iframe = el.tagName === 'IFRAME';
    if (whole) {
      const raw = !!current && !ours && !!rule.replaceable?.(current);
      if (current && !ours && !raw) return; // the site set it
      if (current === token || (ours && !refresh)) return;
      el.setAttribute(attr, token);
      this.record(el, attr, { param: null, original: ours ? record!.original : raw ? null : current, value: token, token, iframe });
      return;
    }
    if (!current) return;
    try {
      const url = new URL(current, window.location.href);
      const existing = url.searchParams.get(rule.param);
      let original = ours ? record!.original : current;
      if (existing && !ours) {
        if (!rule.replaceable?.(existing)) return; // the site set it
        url.searchParams.delete(rule.param);
        original = url.toString();
      } else if (existing && (existing === token || !refresh)) {
        return;
      }
      url.searchParams.set(rule.param, token);
      const next = url.toString();
      el.setAttribute(attr, next);
      this.record(el, attr, { param: rule.param, original, value: next, token, iframe });
    } catch {
      // malformed URL: leave it
    }
  }

  /** Put stamped attributes back; `includeIframes` false keeps iframe stamps (no reload). */
  private restoreAll(includeIframes: boolean): void {
    this.stamped.forEach((byAttr, el) => {
      byAttr.forEach((record, attr) => {
        if (record.iframe && !includeIframes) return;
        byAttr.delete(attr);
        try {
          const current = el.getAttribute(attr);
          if (current === record.value) {
            if (record.original === null) el.removeAttribute(attr);
            else el.setAttribute(attr, record.original);
          } else if (current && record.param) {
            // The site rewrote the link after we stamped it: take only our token out.
            const url = new URL(current, window.location.href);
            if (url.searchParams.get(record.param) === record.token) {
              url.searchParams.delete(record.param);
              el.setAttribute(attr, url.toString());
            }
          } else if (current && !record.param && current === record.token) {
            el.removeAttribute(attr);
          }
        } catch {
          // best-effort
        }
      });
      if (byAttr.size === 0) this.stamped.delete(el);
    });
  }

  private handleClick(e: Event): void {
    if (this.stopped || this.paused) return;
    const anchor = (e.target as Element | null)?.closest?.('a[href]');
    if (!anchor) return;
    const rule = this.ruleFor(anchor.getAttribute('href'));
    if (!rule) return;
    if (this.opts.canDecorate()) {
      const token = this.opts.client.peek();
      if (token) this.stamp(anchor, 'href', rule, token, true, false);
    }
    try {
      this.opts.onLinkClick?.();
    } catch {
      // never block navigation
    }
  }
}
