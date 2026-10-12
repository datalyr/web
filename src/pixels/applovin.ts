/**
 * AppLovin (Axon) pixel, part of dl.pixels.<v>.js (never in dl.js).
 *
 * Loaded exactly as AppLovin's native-JS snippet does ("Axon Pixel: Native
 * JS"): a global AXON_EVENT_KEY, a queueing `axon` stub carrying eventKey, the
 * two scripts below, then axon("init"). Events go out as
 * axon("track", name, data, { dedupe_id }).
 *
 * WHAT LOADING IT MEANS. Once loaded, AppLovin's pixel does its own tracking
 * under AppLovin's terms: it reads the page URL (query included), referrer and
 * title, records landings, clicks and time on page, sets its own first-party
 * cookies (_axwrt, _axeid, ...) and may send page views itself. DATALYR cannot
 * filter any of that. So it is loaded only where the visitor has given
 * marketing consent (Shopify Customer Privacy included, never before it
 * resolves), sends no DNT / GPC / US opt-out signal, and is not in one of
 * AppLovin's excluded countries (decided by ingest from the request), and only
 * for a workspace that connected AppLovin.
 *
 * WHAT DATALYR SENDS THROUGH IT (owner decisions 2026-10-12, KEEP IN SYNC with
 * the postback sender, infra/cloudflare/postback/platforms/applovin-payload.js):
 * - Only events the workspace has an active website AppLovin rule for, under
 *   the name that rule sends. Ingest derives the map (`events`) from the rules;
 *   rules with property conditions are left to the server. Unmapped events, and
 *   page_view always (AppLovin's own pixel counts page views), are not sent.
 * - A purchase only when it carries an order / transaction reference.
 * - Every call carries the server copy's dedupe_id: a purchase's order
 *   reference exactly as data.transaction_id holds it, otherwise the DATALYR
 *   event_id the SDK generated for the event (the ingested copy's event_id).
 *   AppLovin merges two events with one dedupe_id within five minutes.
 * - A value only where ingest says the server would send the event's own value
 *   (`values`): never a client-reported purchase amount the server treats as
 *   unverified, never one a rule replaces with its own.
 * - Never next to another AppLovin install (the Shopify app's theme embed, a
 *   merchant snippet, a GTM tag), checked before loading and again before
 *   every send.
 */
import type { PixelEvent, PixelLoadContext, PixelLoadStatus } from '../destination-pixels';
import { sha256Hex } from '../utils';

/** The two scripts AppLovin's native-JS snippet loads, in its order. */
export const APPLOVIN_PIXEL_SCRIPTS = Object.freeze([
  'https://s.axon.ai/pixel.js',
  'https://res4.applovin.com/p/l/loader.iife.js',
]);

/** AppLovin's standard web event names (applovin-payload.js APPLOVIN_EVENT_NAMES). */
const APPLOVIN_EVENT_NAMES = new Set([
  'page_view', 'view_item', 'add_to_cart', 'remove_from_cart', 'view_cart', 'begin_checkout',
  'add_payment_info', 'purchase', 'generate_lead', 'sign_up', 'login', 'search', 'subscribe',
]);
const APPLOVIN_TRIAL_EVENTS = new Set(['trial_started', 'start_trial']);

export interface AppLovinPixelConfig {
  enabled: boolean;
  /** The connection's AppLovin Event Key (AXON_EVENT_KEY). Public by AppLovin's design. */
  event_key: string;
  /** 'purchase' | 'lead_gen'. Restricted lead-gen accounts never get the browser pixel. */
  account_type?: string;
  /** DATALYR event name → AppLovin name, from the workspace's active website rules. */
  events?: Record<string, string>;
  /** DATALYR event names whose browser copy may carry a value. */
  values?: string[];
}

const lowerText = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** AppLovin's name for one of our events from the rule map, or null (then nothing is sent). */
export function appLovinEventName(eventName: string, config: Pick<AppLovinPixelConfig, 'events' | 'account_type'>): string | null {
  const events = config?.events && typeof config.events === 'object' ? config.events : {};
  const name = Object.prototype.hasOwnProperty.call(events, eventName) ? lowerText(events[eventName]) : '';
  if (!name || name === 'page_view' || !APPLOVIN_EVENT_NAMES.has(name)) return null;
  return appLovinEventAllowed(name, config.account_type) ? name : null;
}

/** Whether an account of this type may send the event (applovin-payload.js appLovinEventAllowed). */
export function appLovinEventAllowed(name: string, accountType?: string): boolean {
  const type = lowerText(accountType) || 'purchase';
  if (type === 'purchase') return APPLOVIN_EVENT_NAMES.has(name);
  if (type === 'lead_gen') return name === 'page_view' || name === 'generate_lead';
  return false; // restricted_lead_gen (domain-only URLs, no email) or unknown: never from the browser
}

/** The sender's text(): a string or finite number, trimmed; undefined when empty. */
export function appLovinText(value: unknown): string | undefined {
  let out: string | undefined;
  if (typeof value === 'string') out = value;
  else if (typeof value === 'number' && Number.isFinite(value)) out = String(value);
  return out && out.trim() ? out.trim() : undefined;
}

function firstText(object: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = appLovinText(object?.[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * The order / invoice / charge id an event names, or undefined. Same keys, same
 * order as the sender's appLovinOrderReference.
 */
export function appLovinOrderReference(properties: any): string | undefined {
  const own = (object: string) => (lowerText(properties?.object) === object ? appLovinText(properties?.id) : undefined);
  return firstText(properties, ['order_id', 'transaction_id'])
    || own('invoice') || firstText(properties, ['invoice', 'invoice_id'])
    || own('charge') || firstText(properties, ['charge', 'charge_id', 'payment_intent', 'checkout_id']);
}

/** The `dedupe_id` (applovin-payload.js appLovinDedupeId, contract of 2026-10-12). */
export function appLovinDedupeId(input: { eventName?: string; eventId?: string; transactionId?: unknown; orderId?: unknown }): string | undefined {
  const reference = appLovinText(input.transactionId) || appLovinText(input.orderId);
  if (lowerText(input.eventName) === 'purchase' && reference) return reference;
  return appLovinText(input.eventId);
}

function appLovinNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) return undefined;
  return Number(value);
}

function firstNumber(object: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = appLovinNumber(object?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function dropEmpty<T extends Record<string, unknown>>(object: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out as T;
}

const APPLOVIN_IMAGE_URL = /^https?:\/\/[^\s]+\.(png|jpe?g)(\?[^\s]*)?$/i;

/**
 * One Axon item from a line item / product object (applovin-payload.js
 * mapAppLovinItem, plus `product_title`, the name dl.js's own Shopify product
 * view uses). item_id is the PARENT product, so it joins AppLovin's catalog.
 */
export function appLovinItem(raw: any): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = firstText(raw, ['product_id', 'item_id', 'productId', 'id', 'sku', 'variant_id']);
  if (!itemId) return null;
  const quantity = firstNumber(raw, ['quantity', 'qty', 'num_items']);
  const units = quantity !== undefined && quantity > 0 ? quantity : 1;
  const unitPrice = firstNumber(raw, ['price', 'item_price', 'unit_price', 'content_price']);
  let discount = firstNumber(raw, ['discount', 'unit_discount']);
  const lineDiscount = firstNumber(raw, ['total_discount', 'line_discount']);
  if (discount === undefined && lineDiscount !== undefined && lineDiscount > 0) discount = lineDiscount / units;
  const discounted = unitPrice !== undefined && discount !== undefined ? Math.max(0, unitPrice - discount) : unitPrice;
  const image = firstText(raw, ['image_url', 'image', 'imageUrl']);
  const category = appLovinNumber(raw.item_category_id ?? raw.google_product_category_id ?? raw.google_product_category);
  const item = dropEmpty({
    item_id: itemId,
    item_variant_id: firstText(raw, ['variant_id', 'item_variant_id', 'variantId']),
    item_name: firstText(raw, ['title', 'name', 'item_name', 'product_name', 'product_title', 'content_name']),
    price: discounted !== undefined ? round2(discounted) : undefined,
    discount: discount !== undefined && discount > 0 ? round2(discount) : undefined,
    quantity: units,
    image_url: image && APPLOVIN_IMAGE_URL.test(image) ? image : undefined,
    item_brand: firstText(raw, ['vendor', 'brand', 'item_brand']),
    item_category_id: category !== undefined && Number.isInteger(category) && category > 0 ? category : undefined,
  });
  if (item.item_variant_id === item.item_id) delete item.item_variant_id;
  return item;
}

const APPLOVIN_ITEM_LISTS = ['items', 'line_items', 'products', 'contents'];

/**
 * The event's items: its first non-empty item list (the sender's list paths),
 * else the one product a single-product event names at the top level (dl.js's
 * Shopify view_item / add_to_cart shape), else none.
 */
export function appLovinItems(properties: any): Array<Record<string, unknown>> {
  if (!properties || typeof properties !== 'object') return [];
  const nested = properties.properties && typeof properties.properties === 'object' ? properties.properties : null;
  const lists = [...APPLOVIN_ITEM_LISTS.map((key) => properties[key]), nested?.items, nested?.products];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) {
      return list.map(appLovinItem).filter((item): item is Record<string, unknown> => !!item).slice(0, 100);
    }
  }
  if (firstText(properties, ['product_id', 'item_id', 'variant_id', 'sku'])) {
    const item = appLovinItem(properties);
    if (item) return [item];
  }
  return [];
}

/** Stripe / Whop style payments carry no line items (applovin-payload.js synthesizedAppLovinItem). */
function synthesizedAppLovinItem(properties: any, value: number | undefined): Record<string, unknown> | null {
  const first = (keys: string[]) => {
    for (const key of keys) {
      const raw = key.split('.').reduce((object: any, part) => object?.[part], properties);
      const text = Array.isArray(raw) ? appLovinText(raw[0]) : appLovinText(raw);
      if (text) return text;
    }
    return undefined;
  };
  const productId = first(['product_id', 'product_ids', 'plan.product', 'whop_product_id']);
  const priceId = first(['price_id', 'price_ids', 'plan.id', 'plan_id']);
  const itemId = productId || priceId;
  if (!itemId) return null;
  return dropEmpty({
    item_id: itemId,
    item_variant_id: priceId && priceId !== itemId ? priceId : undefined,
    item_name: first(['product_name', 'plan_name', 'plan.nickname', 'description']),
    price: value !== undefined ? round2(value) : undefined,
    quantity: 1,
  });
}

/**
 * AppLovin's email normalization ("Events and objects"): trimmed, lowercased,
 * printable ASCII with exactly one @; for gmail.com / googlemail.com the dots
 * and the first + and everything after it go from the local part.
 */
export function appLovinNormalizedEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!/^[!-?A-~]+@[!-?A-~]+$/.test(email)) return null;
  const at = email.indexOf('@');
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
  }
  return local ? `${local}@${domain}` : null;
}

/**
 * The `data` object for one AppLovin event (AppLovin's "Events and objects",
 * shaped as the sender shapes it), or null when the event must not be sent.
 * `sendValue` false leaves `value` out entirely (the server copy carries it).
 */
export function appLovinEventData(
  name: string, eventName: string, properties: any,
  { sendValue = false }: { sendValue?: boolean } = {},
): Record<string, unknown> | null {
  const props = properties && typeof properties === 'object' ? properties : {};
  if (name === 'page_view') return null;
  if (name === 'login') return {};
  const declared = typeof props.currency === 'string' && /^[A-Za-z]{3}$/.test(props.currency.trim())
    ? props.currency.trim().toUpperCase() : undefined;
  const currency = declared || 'USD';
  const items = appLovinItems(props);
  const value = firstNumber(props, ['value', 'revenue']);
  switch (name) {
    case 'purchase': {
      // Only with an order reference: it is the dedupe_id the server copy carries.
      const reference = appLovinOrderReference(props);
      if (!reference) return null;
      // "The total monetary amount due before tax and shipping (the subtotal)".
      const amount = sendValue
        ? firstNumber(props, ['current_subtotal_price', 'subtotal_price', 'subtotal', 'total_excluding_tax', 'subtotal_excluding_tax']) ?? value
        : undefined;
      if (sendValue && !(amount !== undefined && amount > 0)) return null; // the sender skips a $0 purchase
      const synthesized = items.length ? null : synthesizedAppLovinItem(props, amount);
      const tax = firstNumber(props, ['total_tax', 'tax', 'amount_tax', 'tax_amount']);
      return dropEmpty({
        currency,
        value: amount !== undefined ? round2(amount) : undefined,
        items: items.length ? items : (synthesized ? [synthesized] : undefined),
        shipping: round2(firstNumber(props, ['total_shipping', 'shipping', 'total_shipping_price', 'shipping_amount']) ?? 0),
        tax: tax !== undefined ? round2(tax) : undefined,
        transaction_id: reference,
      });
    }
    case 'subscribe': {
      if (!sendValue) return { currency };
      const trial = APPLOVIN_TRIAL_EVENTS.has(lowerText(eventName));
      const trialValue = trial ? appLovinNumber(props.trial_expected_value) : undefined;
      const amount = trial ? (trialValue !== undefined && trialValue > 0 ? trialValue : 0) : (value ?? 0);
      return { currency, value: round2(Math.max(0, amount)) };
    }
    case 'generate_lead':
      if (!sendValue) return { currency };
      // value is required and 0 means "low quality": never invented.
      if (value === undefined) return null;
      return { currency, value: round2(Math.max(0, value)) };
    case 'add_payment_info':
      return dropEmpty({
        currency,
        value: sendValue ? round2(Math.max(0, value ?? 0)) : undefined,
        items: items.length ? items : undefined,
        payment_type: firstText(props, ['payment_type', 'paymentType']),
      });
    case 'begin_checkout': {
      const amount = value ?? items.reduce((sum, item: any) => sum + (item.price ?? 0) * (item.quantity ?? 1), 0);
      return dropEmpty({ currency, value: sendValue ? round2(Math.max(0, amount)) : undefined, items });
    }
    case 'view_item':
    case 'add_to_cart':
    case 'remove_from_cart':
    case 'view_cart':
      return dropEmpty({ currency, value: sendValue && value !== undefined ? round2(value) : undefined, items });
    case 'search':
      return dropEmpty({ search_term: firstText(props, ['search_term', 'query', 'search_query', 'search_string', 'q']) });
    case 'sign_up':
      return dropEmpty({ method: firstText(props, ['method', 'signup_method', 'auth_method']) });
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Other AppLovin installs on the page
// ---------------------------------------------------------------------------

/** AppLovin's own snippet: `var AXON_EVENT_KEY = "...";` (never in DATALYR's code). */
const SNIPPET = /\bvar\s+AXON_EVENT_KEY\s*=/;
const FOREIGN_SCRIPT_SELECTOR = APPLOVIN_PIXEL_SCRIPTS
  .map((src) => `script[src^="${src.replace(/\.(iife\.)?js$/, '')}"]:not([data-datalyr-pixel])`).join(',');

/** Every string inside a (parsed) Shopify web pixel configuration, nested JSON strings included. */
function configurationStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push(value.trim());
    if (value.length > 1 && (value[0] === '{' || value[0] === '[')) {
      try { configurationStrings(JSON.parse(value), depth + 1, out); } catch { /* not JSON */ }
    }
  } else if (typeof value === 'object') {
    for (const key of Object.keys(value as object)) configurationStrings((value as any)[key], depth + 1, out);
  }
  return out;
}

/**
 * Another AppLovin install is on the page (checked before loading ours):
 * - window.axon exists and is not ours (the snippet, a GTM tag or the Shopify
 *   app's theme embed has run; the pixel keeps ONE event key per page),
 * - one of AppLovin's two pixel scripts is a script src in the document,
 * - an inline script holds AppLovin's snippet (`var AXON_EVENT_KEY =`), parsed
 *   but possibly not run yet,
 * - Shopify's web pixel config carries this Event Key (the app's web pixel; its
 *   apiClientId is undocumented, so it is matched on the key).
 */
export function appLovinPixelOnPage(eventKey: string, shopifyPixels: unknown[] = [], doc?: Document): boolean {
  try {
    const host = typeof window !== 'undefined' ? (window as any) : undefined;
    if (host && host.axon && !host.axon.__datalyr) return true;
    const root = doc || (typeof document !== 'undefined' ? document : undefined);
    if (root) {
      if (root.querySelector(FOREIGN_SCRIPT_SELECTOR)) return true;
      const scripts = root.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (script.src || script.dataset?.datalyrPixel) continue;
        if (SNIPPET.test(script.text || script.textContent || '')) return true;
      }
    }
    const wanted = String(eventKey || '').trim();
    if (wanted && shopifyPixels.some((entry: any) => configurationStrings(entry?.configuration).includes(wanted))) return true;
  } catch { /* DOM access failed: no signal */ }
  return false;
}

/**
 * The cheap check before every send: an install that arrived after ours (a
 * GTM tag or a consent-released tag) replaced window.axon, reset
 * AXON_EVENT_KEY, or added AppLovin's scripts.
 */
export function foreignAppLovinInstall(ours: unknown, eventKey: string): boolean {
  try {
    const host = window as any;
    if (host.AXON_EVENT_KEY !== eventKey) return true;
    const current = host.axon;
    if (current !== ours && !(current && current.eventKey === eventKey)) return true;
    return !!document.querySelector(FOREIGN_SCRIPT_SELECTOR);
  } catch {
    return true;
  }
}

function waitForParsedDocument(timeoutMs: number): Promise<void> {
  if (typeof document === 'undefined' || document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('DOMContentLoaded', done);
      resolve();
    };
    document.addEventListener('DOMContentLoaded', done);
    timer = setTimeout(done, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// The platform
// ---------------------------------------------------------------------------

export class AppLovinPixel {
  private stub: unknown = null;
  private key: string | null = null;
  private companion = false;

  isCompanion(): boolean {
    return this.companion;
  }

  /**
   * The one-time load decision. Other installs sit further down the page
   * (Shopify app embeds at the end of <body>), so it waits (bounded) for the
   * HTML to be parsed first, then re-checks the gate: consent withdrawn during
   * the wait means 'retry' (the Container decides again when allowed).
   */
  async load(config: AppLovinPixelConfig, ctx: PixelLoadContext): Promise<PixelLoadStatus> {
    if (this.stub) return 'loaded';
    const key = typeof config?.event_key === 'string' ? config.event_key.trim() : '';
    if (!config || config.enabled !== true || !key) return 'blocked';
    if (!appLovinEventAllowed('generate_lead', config.account_type) && !appLovinEventAllowed('purchase', config.account_type)) return 'blocked';
    if (!ctx.allowed()) return 'retry';
    await waitForParsedDocument(2000);
    if (!ctx.allowed()) return 'retry';
    if (appLovinPixelOnPage(key, ctx.readShopifyPixels())) {
      this.companion = true;
      ctx.log('AppLovin pixel already on this page; the Container does not load a second one');
      return 'companion';
    }
    const host = window as any;
    // AppLovin's native-JS snippet, unchanged in substance: the global event key,
    // the queueing stub, both scripts, then init. Our scripts are marked so no
    // later check mistakes them for another install.
    host.AXON_EVENT_KEY = key;
    (function (e: any, r: Document) {
      const t = APPLOVIN_PIXEL_SCRIPTS;
      if (!e.axon) {
        const a: any = e.axon = function () {
          // eslint-disable-next-line prefer-rest-params
          a.performOperation ? a.performOperation.apply(a, arguments) : a.operationQueue.push(arguments);
        };
        a.operationQueue = [];
        a.ts = Date.now();
        a.eventKey = e.AXON_EVENT_KEY;
        a.__datalyr = true;
        const n = r.getElementsByTagName('script')[0];
        for (let o = 0; o < t.length; o++) {
          const i = r.createElement('script');
          i.async = true;
          i.src = t[o];
          i.dataset.datalyrPixel = 'applovin';
          if (n?.parentNode) n.parentNode.insertBefore(i, n);
          else r.head.appendChild(i);
        }
      }
    })(host, document);
    host.axon('init');
    this.stub = host.axon;
    this.key = key;
    ctx.log('AppLovin pixel initialized');
    return 'loaded';
  }

  async track(config: AppLovinPixelConfig, event: PixelEvent, ctx: { allowed: () => boolean }): Promise<boolean> {
    if (!this.stub || !this.key || this.companion || !ctx.allowed()) return false;
    if (config?.event_key !== this.key) return false;
    if (foreignAppLovinInstall(this.stub, this.key)) {
      // Another install arrived after ours: it owns the page from here on.
      this.companion = true;
      return false;
    }
    const name = appLovinEventName(event.name, config);
    if (!name) return false;
    const sendValue = Array.isArray(config.values) && config.values.includes(event.name);
    const data = appLovinEventData(name, event.name, event.properties, { sendValue });
    if (!data) return false;
    const dedupeId = appLovinDedupeId({ eventName: name, eventId: event.eventId, transactionId: data.transaction_id });
    // Without the shared id the pixel copy could never merge with the server copy.
    if (!dedupeId) return false;
    if (name === 'purchase' || name === 'sign_up') {
      // user_data is required on these two; only the identified email, hashed
      // with AppLovin's own normalization (never Meta's).
      const email = appLovinNormalizedEmail(event.email);
      const hash = email ? await sha256Hex(email) : null;
      if (hash) data.user_data = { email: hash };
      if (!ctx.allowed()) return false;
    }
    const axon = (window as any).axon;
    if (typeof axon !== 'function') return false;
    axon('track', name, data, { dedupe_id: dedupeId });
    return true;
  }
}
