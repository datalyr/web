/**
 * X Pixel, part of dl.pixels.<v>.js (never in dl.js). CHECKLIST Phase 3.2b.
 *
 * Loaded exactly as X's base code does: a queueing `twq` stub (version 1.1),
 * static.ads-twitter.com/uwt.js, then twq('config', <pixel id>), which is what
 * sends X's own page view. Conversions go out as
 *   twq('event', 'tw-<pixel>-<event>', { conversion_id, value, currency, contents })
 *
 * WHAT LOADING IT MEANS. Once loaded, X's pixel does its own tracking under
 * X's terms (page views, its cookies, the page URL). It is loaded only with
 * marketing consent (Shopify Customer Privacy included, never before it
 * resolves), without a DNT / GPC / US opt-out signal, and only for a workspace
 * whose active x-ads connection and the X destination gate let ingest send
 * `pixels.x`.
 *
 * WHAT DATALYR SENDS THROUGH IT (KEEP IN SYNC with the postback sender,
 * infra/cloudflare/postback/platforms/x-payload.js on the worker branch):
 * - Only events with an active website X rule, under that rule's X Event ID
 *   (ingest derives `events` from the rules; conditioned rules stay server-side).
 *   Page views are never sent as events: twq('config') counts them.
 * - conversion_id, X's dedup key with the event id (48 h): xConversionId — a
 *   purchase (the rule's X event type is PURCHASE; ingest lists those triggers
 *   in `purchases`) carries its order / transaction reference exactly as
 *   recorded, everything else (and a purchase without one) the DATALYR
 *   event_id the SDK generated for the event (the ingested copy's event_id).
 * - A value only where ingest says the server sends the event's own value
 *   (`values`), read exactly as the server reads it (serverEventValue: the
 *   first present VALUE_FALLBACK_PATHS field); never a client purchase amount
 *   the server treats as unverified.
 * - The currency the server sends (serverCurrency: the event's, else the
 *   rule's from ingest's `currencies`, else USD; no trimming). One the
 *   sender's /^[A-Z]{3}$/ check rejects means the server skips the whole
 *   conversion, so the browser sends nothing either.
 * - A PURCHASE only when it can be as strong as the server copy (owner
 *   decision 2026-10-12): its trigger is in `values` and its value is above 0.
 *   Anything less is left to the server (which may also skip it: zero value,
 *   money authority, renewals; ingest leaves rules with gates the browser
 *   cannot evaluate out of `events`).
 * - No personal data from the browser: no email_address, no phone_number.
 * - Never next to another X Pixel install (theme code, GTM, a Shopify app),
 *   checked before loading and again before every send.
 *
 * X's uwt.js does automatic advanced matching: once loaded it reads form
 * fields on the page (emails, phone numbers) and hashes them for matching. That
 * is X's own collection under X's terms, another reason it loads only with
 * marketing consent; merchants can turn it off in X Events Manager.
 */
import type { PixelEvent, PixelLoadContext, PixelLoadStatus, PixelTrackContext } from '../destination-pixels';
import {
  appLovinDedupeId, appLovinNumber, appLovinOrderReference, appLovinText, configurationStrings, firstItemList,
  serverCurrency, serverEventValue, waitForParsedDocument,
} from './applovin';

export const X_PIXEL_SCRIPT = 'https://static.ads-twitter.com/uwt.js';

export interface XPixelConfig {
  enabled: boolean;
  /** The connection's X pixel id (metadata.pixel_id). Public: it is in X's base code. */
  pixel_id: string;
  /** DATALYR event name → X Event ID (tw-<pixel>-<event>), from active website X rules. */
  events?: Record<string, string>;
  /** DATALYR event names whose browser copy may carry a value. */
  values?: string[];
  /** DATALYR event names whose rule is an X PURCHASE (conversion_id = order reference). */
  purchases?: string[];
  /** DATALYR event name → the rule's config.currency (the server's fallback before USD). */
  currencies?: Record<string, string>;
}

const EVENT_ID = /^(tw-[a-z0-9]+-)?[a-z0-9]+$/i;
const PIXEL_ID = /^[a-z0-9]{1,40}$/i;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function dropEmpty<T extends Record<string, unknown>>(object: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out as T;
}

/** The event's full X Event ID (`tw-<pixel>-<event>`), or null when it has none. */
export function xEventIdFor(eventName: string, config: Pick<XPixelConfig, 'events' | 'pixel_id'>): string | null {
  const events = config?.events && typeof config.events === 'object' ? config.events : {};
  if (!Object.prototype.hasOwnProperty.call(events, eventName)) return null;
  const raw = appLovinText(events[eventName]);
  if (!raw || !EVENT_ID.test(raw)) return null;
  if (/^tw-/i.test(raw)) return raw;
  const pixel = appLovinText(config.pixel_id);
  return pixel && PIXEL_ID.test(pixel) ? `tw-${pixel}-${raw}` : null;
}

/**
 * conversion_id (x-payload.js xConversionId): the AppLovin dedupe_id contract —
 * a purchase → its order reference, else the DATALYR event id. `properties`
 * are the RAW id fields (PixelEvent.ids), never sanitised ones.
 */
export function xConversionId(input: { purchase: boolean; properties: unknown; eventId?: string }): string | undefined {
  return appLovinDedupeId({
    eventName: input.purchase ? 'purchase' : 'other',
    transactionId: appLovinOrderReference(input.properties),
    eventId: input.eventId,
  });
}

function firstText(object: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = appLovinText(object?.[key]);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(object: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = appLovinNumber(object?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** One X content (x-payload.js mapXContent). */
export function xContent(raw: any): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const contentId = firstText(raw, ['sku', 'gtin', 'content_id', 'variant_id', 'product_id', 'id', 'item_id']);
  if (!contentId) return null;
  const product = firstText(raw, ['product_id', 'content_group_id']);
  const quantity = firstNumber(raw, ['quantity', 'qty', 'num_items']);
  const price = firstNumber(raw, ['price', 'item_price', 'unit_price', 'content_price']);
  return dropEmpty({
    content_id: contentId,
    content_group_id: product && product !== contentId ? product : undefined,
    content_name: firstText(raw, ['title', 'name', 'content_name', 'product_name', 'item_name']),
    content_type: firstText(raw, ['product_type', 'category', 'content_type', 'item_category']),
    content_price: price !== undefined ? round2(price) : undefined,
    num_items: quantity !== undefined && quantity > 0 ? Math.max(1, Math.round(quantity)) : 1,
  });
}

/** The event's contents (x-payload.js xContents: its ITEM_LIST_PATHS, in order). */
export function xContents(properties: any): Array<Record<string, unknown>> {
  const list = firstItemList(properties);
  return list ? list.map(xContent).filter((item): item is Record<string, unknown> => !!item).slice(0, 100) : [];
}

/**
 * The parameters of one twq('event') call, or null when the event must not be
 * sent: a currency the sender's check rejects (it skips the conversion), or a
 * purchase that would be weaker than the server copy. Never personal data.
 */
export function xEventParameters(properties: any, { purchase, sendValue, conversionId, ruleCurrency }:
  { purchase: boolean; sendValue: boolean; conversionId: string; ruleCurrency?: unknown }): Record<string, unknown> | null {
  const props = properties && typeof properties === 'object' ? properties : {};
  const currency = serverCurrency(props, ruleCurrency);
  if (!currency) return null;
  const raw = sendValue ? serverEventValue(props) : undefined;
  const value = raw !== undefined && raw >= 0 ? round2(raw) : undefined;
  // A purchase only as strong as the server copy: value allowed and above 0.
  if (purchase && !(value !== undefined && value > 0)) return null;
  const contents = xContents(props);
  return dropEmpty({
    conversion_id: conversionId,
    value,
    currency: value !== undefined ? currency : undefined,
    contents: contents.length ? contents : undefined,
  });
}

// ---------------------------------------------------------------------------
// Other X Pixel installs on the page
// ---------------------------------------------------------------------------

const FOREIGN_SCRIPT_SELECTOR = `script[src^="${X_PIXEL_SCRIPT.replace(/\.js$/, '')}"]:not([data-datalyr-pixel])`;
/** X's base code itself: its uwt.js URL and a twq config / init call, in one inline script. */
const SNIPPET_URL = /static\.ads-twitter\.com\/uwt\.js/;
const SNIPPET_CALL = /\btwq\s*\(\s*["'](?:config|init)["']/;

/** Another X Pixel install is on the page (checked before loading ours). */
export function xPixelOnPage(pixelId: string, shopifyPixels: unknown[] = [], doc?: Document): boolean {
  try {
    const host = typeof window !== 'undefined' ? (window as any) : undefined;
    if (host && host.twq && !host.twq.__datalyr) return true;
    const root = doc || (typeof document !== 'undefined' ? document : undefined);
    if (root) {
      if (root.querySelector(FOREIGN_SCRIPT_SELECTOR)) return true;
      const scripts = root.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (script.src || script.dataset?.datalyrPixel) continue;
        const text = script.text || script.textContent || '';
        if (SNIPPET_URL.test(text) && SNIPPET_CALL.test(text)) return true;
      }
    }
    const wanted = String(pixelId || '').trim();
    if (wanted && shopifyPixels.some((entry: any) => configurationStrings(entry?.configuration).includes(wanted))) return true;
  } catch { /* DOM access failed: no signal */ }
  return false;
}

/** X's own twq once uwt.js has run: the base code's shape (exe or version). */
function isXTwq(value: any): boolean {
  return typeof value === 'function' && (typeof value.exe === 'function' || typeof value.version === 'string');
}

/**
 * Before every send. 'ours': window.twq is still our stub. 'replaced': X's own
 * code put another twq in place (it has exe / version): keep sending through
 * it. 'foreign': something else replaced it, or another install added uwt.js.
 */
export function xTwqState(ours: unknown): 'ours' | 'replaced' | 'foreign' {
  try {
    if (document.querySelector(FOREIGN_SCRIPT_SELECTOR)) return 'foreign';
    const current = (window as any).twq;
    if (current === ours) return 'ours';
    return isXTwq(current) ? 'replaced' : 'foreign';
  } catch {
    return 'foreign';
  }
}

export class XPixel {
  private stub: unknown = null;
  private pixelId: string | null = null;
  private companion = false;
  private queuedLogged = false;

  isCompanion(): boolean {
    return this.companion;
  }

  async load(config: XPixelConfig, ctx: PixelLoadContext): Promise<PixelLoadStatus> {
    if (this.stub) return 'loaded';
    const pixelId = typeof config?.pixel_id === 'string' ? config.pixel_id.trim() : '';
    if (!config || config.enabled !== true || !PIXEL_ID.test(pixelId)) return 'blocked';
    if (!ctx.allowed()) return 'retry';
    await waitForParsedDocument(2000);
    if (!ctx.allowed()) return 'retry';
    if (xPixelOnPage(pixelId, ctx.readShopifyPixels())) {
      this.companion = true;
      ctx.log('X Pixel already on this page; the Container does not load a second one');
      return 'companion';
    }
    const host = window as any;
    // X's base code, unchanged in substance. Our script is marked so no later
    // check mistakes it for another install.
    (function (e: any, t: Document, n: string) {
      if (e.twq) return;
      const s: any = e.twq = function () {
        // eslint-disable-next-line prefer-rest-params
        s.exe ? s.exe.apply(s, arguments) : s.queue.push(arguments);
      };
      s.version = '1.1';
      s.queue = [];
      s.__datalyr = true;
      const u = t.createElement(n) as HTMLScriptElement;
      u.async = true;
      u.src = X_PIXEL_SCRIPT;
      u.dataset.datalyrPixel = 'x';
      const a = t.getElementsByTagName(n)[0];
      if (a?.parentNode) a.parentNode.insertBefore(u, a);
      else t.head.appendChild(u);
    })(host, document, 'script');
    // config sends X's page view for this page.
    host.twq('config', pixelId);
    this.stub = host.twq;
    this.pixelId = pixelId;
    ctx.log('X Pixel initialized');
    return 'loaded';
  }

  async track(config: XPixelConfig, event: PixelEvent, ctx: PixelTrackContext): Promise<boolean> {
    if (!this.stub || !this.pixelId || this.companion || !ctx.allowed()) return false;
    const pixelId = typeof config?.pixel_id === 'string' ? config.pixel_id.trim() : '';
    if (pixelId !== this.pixelId) return false;
    const state = xTwqState(this.stub);
    if (state === 'foreign') {
      this.companion = true;
      ctx.log?.('X Pixel: another install took window.twq or added uwt.js; the Container stops sending');
      return false;
    }
    if (state === 'replaced') {
      ctx.log?.('X Pixel: window.twq was replaced by X\'s own code; sending through it');
      this.stub = (window as any).twq;
    }
    const eventId = xEventIdFor(event.name, config);
    if (!eventId) return false;
    const purchase = Array.isArray(config.purchases) && config.purchases.includes(event.name);
    // The RAW id fields only (never the sanitised properties): the server's id.
    const conversionId = xConversionId({ purchase, properties: event.ids ?? {}, eventId: event.eventId });
    // Without the shared id the pixel copy could never dedupe with the server copy.
    if (!conversionId) return false;
    const sendValue = Array.isArray(config.values) && config.values.includes(event.name);
    const currencies = config.currencies && typeof config.currencies === 'object' ? config.currencies : {};
    const ruleCurrency = Object.prototype.hasOwnProperty.call(currencies, event.name) ? currencies[event.name] : undefined;
    const parameters = xEventParameters(event.properties, { purchase, sendValue, conversionId, ruleCurrency });
    if (!parameters) return false;
    const twq = (window as any).twq;
    if (typeof twq !== 'function') return false;
    twq('event', eventId, parameters);
    // Delivered only once uwt.js runs (it sets twq.exe). Until then the call
    // waits in the queue (sent if uwt.js arrives); blocked, it never leaves.
    if (typeof twq.exe !== 'function') {
      // Once per page: a blocked uwt.js is a state, not a failure per event.
      if (!this.queuedLogged) {
        this.queuedLogged = true;
        ctx.log?.('X Pixel: uwt.js has not run (yet); events wait in its queue and are not reported delivered');
      }
      return false;
    }
    return true;
  }
}
