/**
 * LinkedIn Insight Tag, part of dl.pixels.<v>.js (never in dl.js). CHECKLIST Phase 4.x.
 *
 * Loaded as LinkedIn's base code does: `window._linkedin_partner_id = <pid>`,
 * the id pushed to `window._linkedin_data_partner_ids`, a queueing `lintrk`
 * stub (`lintrk.q`), then snap.licdn.com/li.lms-analytics/insight.min.js, which
 * counts LinkedIn's page view itself. Conversions go out as
 *   lintrk('track', { conversion_id: <Insight Tag conversion id>, event_id: <DATALYR event_id> })
 *
 * WHAT LOADING IT MEANS. Once loaded, the Insight Tag does its own tracking
 * under LinkedIn's terms (page views, its li_fat_id / cookies, the page URL).
 * It is loaded only with marketing consent (Shopify Customer Privacy included,
 * never before it resolves), without a DNT / GPC / US opt-out signal, and only
 * for a workspace whose active linkedin-ads connection and the LinkedIn
 * destination gate let ingest send `pixels.linkedin`.
 *
 * WHAT DATALYR SENDS THROUGH IT (KEEP IN SYNC with ingest's
 * infra/cloudflare/ingest/linkedin-pixel.js and the postback LinkedIn sender):
 * - Only events ingest lists in `events` (DATALYR name -> the paired Insight Tag
 *   conversion id). LinkedIn keeps the Insight Tag copy and DISCARDS the
 *   Conversions API copy when both share an eventId, and the Insight Tag has no
 *   documented value parameter, so ingest lists a trigger only when the browser
 *   copy loses nothing against the server copy (FIXED / NO_VALUE rules, or rules
 *   that send no value on a non-money trigger).
 * - event_id = the DATALYR event_id the SDK generated (the ingested copy's
 *   event_id), which the server sends as eventId. No event id: nothing is sent
 *   (the two copies could never dedupe).
 * - Never a value, a currency or personal data. Never page views (the base tag
 *   counts them).
 * - Never next to another Insight Tag install (theme code, GTM, a Shopify app),
 *   checked before loading and again before every send.
 *
 * DELIVERED. An event counts as delivered only once insight.min.js has run.
 * Heuristic (LinkedIn does not document its runtime): the script sets
 * `window._already_called_lintrk = true` when it initializes and replaces the
 * queueing stub with its own `lintrk`; until both are true the call only waits
 * in `lintrk.q` (sent if the script arrives; blocked, it never leaves).
 */
import type { PixelEvent, PixelLoadContext, PixelLoadStatus, PixelTrackContext } from '../destination-pixels';
import { appLovinText, configurationStrings, waitForParsedDocument } from './applovin';

export const LINKEDIN_INSIGHT_SCRIPT = 'https://snap.licdn.com/li.lms-analytics/insight.min.js';

export interface LinkedInInsightTagConfig {
  enabled: boolean;
  /** The connection's Insight Tag partner id (metadata.insight_tag_partner_id). Public: it is in LinkedIn's base code. */
  partner_id: string;
  /** DATALYR event name → Insight Tag conversion id (digits), from active website LinkedIn rules. */
  events?: Record<string, string>;
}

const DIGITS = /^\d{1,20}$/;

/** The event's Insight Tag conversion id as a number, or null when it has none. */
export function linkedInConversionIdFor(eventName: string, config: Pick<LinkedInInsightTagConfig, 'events'>): number | null {
  const events = config?.events && typeof config.events === 'object' ? config.events : {};
  if (!Object.prototype.hasOwnProperty.call(events, eventName)) return null;
  const raw = (events as Record<string, unknown>)[eventName];
  const text = typeof raw === 'number' ? String(raw) : appLovinText(raw);
  if (!text || !DIGITS.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** The lintrk('track') payload: the conversion id and the shared event id. Nothing else. */
export function linkedInTrackPayload(conversionId: number, eventId: string): { conversion_id: number; event_id: string } {
  return { conversion_id: conversionId, event_id: eventId };
}

// ---------------------------------------------------------------------------
// Other Insight Tag installs on the page
// ---------------------------------------------------------------------------

const SCRIPT_PREFIX = 'https://snap.licdn.com/li.lms-analytics/insight';
const FOREIGN_SCRIPT_SELECTOR = `script[src^="${SCRIPT_PREFIX}"]:not([data-datalyr-pixel])`;
/** LinkedIn's base code itself: the partner id assignment or push, in an inline script. */
const SNIPPET = /\b_linkedin_partner_id\s*=|_linkedin_data_partner_ids\s*\.\s*push\s*\(/;

/**
 * Every string and finite number in a Shopify web pixel configuration, as text
 * (configurationStrings, plus numbers): an app may store the partner id as a
 * JSON number.
 */
export function linkedInConfigurationValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.push(String(value));
  } else if (typeof value === 'string') {
    configurationStrings(value, depth, out);
    if (value.length > 1 && (value[0] === '{' || value[0] === '[')) {
      try { collectNumbers(JSON.parse(value), depth + 1, out); } catch { /* not JSON */ }
    }
  } else if (typeof value === 'object') {
    for (const key of Object.keys(value as object)) linkedInConfigurationValues((value as any)[key], depth + 1, out);
  }
  return out;
}

function collectNumbers(value: unknown, depth: number, out: string[]): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === 'number') { if (Number.isFinite(value)) out.push(String(value)); return; }
  if (typeof value === 'object') for (const key of Object.keys(value as object)) collectNumbers((value as any)[key], depth + 1, out);
}

function partnerIds(): string[] {
  const list = (window as any)._linkedin_data_partner_ids;
  return Array.isArray(list) ? list.map((id: unknown) => String(id).trim()) : [];
}

/** Another Insight Tag install is on the page (checked before loading ours). */
export function linkedInInsightTagOnPage(partnerId: string, shopifyPixels: unknown[] = [], doc?: Document): boolean {
  try {
    const host = typeof window !== 'undefined' ? (window as any) : undefined;
    if (host) {
      if (host.lintrk && !host.lintrk.__datalyr) return true;
      if (partnerIds().length > 0 && !(host.lintrk && host.lintrk.__datalyr)) return true;
      if (host._linkedin_partner_id != null && !(host.lintrk && host.lintrk.__datalyr)) return true;
    }
    const root = doc || (typeof document !== 'undefined' ? document : undefined);
    if (root) {
      if (root.querySelector(FOREIGN_SCRIPT_SELECTOR)) return true;
      const scripts = root.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (script.src || script.dataset?.datalyrPixel) continue;
        const text = script.text || script.textContent || '';
        if (SNIPPET.test(text)) return true;
      }
    }
    const wanted = String(partnerId || '').trim();
    if (wanted && shopifyPixels.some((entry: any) => linkedInConfigurationValues(entry?.configuration).includes(wanted))) return true;
  } catch { /* DOM access failed: no signal */ }
  return false;
}

/** insight.min.js has run (see DELIVERED in the header). */
function insightRan(): boolean {
  try {
    return (window as any)._already_called_lintrk === true;
  } catch {
    return false;
  }
}

/**
 * Before every send. 'ours': window.lintrk is still the one we hold (our stub,
 * or LinkedIn's own once adopted). 'replaced': insight.min.js (loaded by us)
 * has run and put LinkedIn's own lintrk in place of our stub: adopt it and
 * keep sending through it. 'foreign': something else replaced it (any change
 * after LinkedIn's own was adopted counts), another install added
 * insight.min.js, or another partner id joined the page.
 */
export function linkedInLintrkState(ours: unknown, partnerId: string, adopted = false): 'ours' | 'replaced' | 'foreign' {
  try {
    if (document.querySelector(FOREIGN_SCRIPT_SELECTOR)) return 'foreign';
    if (partnerIds().some((id) => id !== partnerId)) return 'foreign';
    const current = (window as any).lintrk;
    if (current === ours) return 'ours';
    return !adopted && typeof current === 'function' && insightRan() ? 'replaced' : 'foreign';
  } catch {
    return 'foreign';
  }
}

export class LinkedInInsightTag {
  private stub: unknown = null;
  private partnerId: string | null = null;
  private companion = false;
  /** window.lintrk is LinkedIn's own (insight.min.js ran and replaced our stub). */
  private adopted = false;
  private queuedLogged = false;

  isCompanion(): boolean {
    return this.companion;
  }

  async load(config: LinkedInInsightTagConfig, ctx: PixelLoadContext): Promise<PixelLoadStatus> {
    if (this.stub) return 'loaded';
    const partnerId = typeof config?.partner_id === 'string' ? config.partner_id.trim() : '';
    if (!config || config.enabled !== true || !DIGITS.test(partnerId)) return 'blocked';
    if (!ctx.allowed()) return 'retry';
    await waitForParsedDocument(2000);
    if (!ctx.allowed()) return 'retry';
    if (linkedInInsightTagOnPage(partnerId, ctx.readShopifyPixels())) {
      this.companion = true;
      ctx.log('LinkedIn Insight Tag already on this page; the Container does not load a second one');
      return 'companion';
    }
    const host = window as any;
    // LinkedIn's base code, unchanged in substance. Our script is marked so no
    // later check mistakes it for another install.
    host._linkedin_partner_id = partnerId;
    host._linkedin_data_partner_ids = host._linkedin_data_partner_ids || [];
    if (!partnerIds().includes(partnerId)) host._linkedin_data_partner_ids.push(partnerId);
    (function (l: any) {
      if (!l) {
        const stub: any = host.lintrk = function (a: unknown, b: unknown) { host.lintrk.q.push([a, b]); };
        stub.q = [];
        stub.__datalyr = true;
      }
      const s = document.getElementsByTagName('script')[0];
      const b = document.createElement('script');
      b.type = 'text/javascript';
      b.async = true;
      b.src = LINKEDIN_INSIGHT_SCRIPT;
      b.dataset.datalyrPixel = 'linkedin';
      if (s?.parentNode) s.parentNode.insertBefore(b, s);
      else document.head.appendChild(b);
    })(host.lintrk);
    this.stub = host.lintrk;
    this.partnerId = partnerId;
    ctx.log('LinkedIn Insight Tag initialized');
    return 'loaded';
  }

  async track(config: LinkedInInsightTagConfig, event: PixelEvent, ctx: PixelTrackContext): Promise<boolean> {
    if (!this.stub || !this.partnerId || this.companion || !ctx.allowed()) return false;
    const partnerId = typeof config?.partner_id === 'string' ? config.partner_id.trim() : '';
    if (partnerId !== this.partnerId) return false;
    const name = String(event?.name ?? '').toLowerCase();
    if (name === 'pageview' || name === 'page_view') return false;
    const state = linkedInLintrkState(this.stub, this.partnerId, this.adopted);
    if (state === 'foreign') {
      this.companion = true;
      ctx.log?.('LinkedIn Insight Tag: another install took window.lintrk or added insight.min.js; the Container stops sending');
      return false;
    }
    if (state === 'replaced') {
      this.stub = (window as any).lintrk;
      this.adopted = true;
    }
    const conversionId = linkedInConversionIdFor(event.name, config);
    if (conversionId === null) return false;
    // Without the shared id the browser copy could never dedupe with the server copy.
    const eventId = typeof event.eventId === 'string' ? event.eventId.trim() : '';
    if (!eventId) return false;
    const lintrk = (window as any).lintrk;
    if (typeof lintrk !== 'function') return false;
    lintrk('track', linkedInTrackPayload(conversionId, eventId));
    // Delivered only once insight.min.js has run and replaced our stub.
    if (!this.adopted) {
      if (!this.queuedLogged) {
        this.queuedLogged = true;
        ctx.log?.('LinkedIn Insight Tag: insight.min.js has not run (yet); events wait in its queue and are not reported delivered');
      }
      return false;
    }
    return true;
  }
}
