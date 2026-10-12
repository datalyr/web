/**
 * Destination pixels loader (part of dl.js; the pixels themselves are NOT).
 *
 * Ad platforms whose browser pixel the Container runs next to DATALYR's server
 * sender (AppLovin today; the X Pixel and the LinkedIn Insight Tag are meant to
 * join it) live in one separate module, dl.pixels.<v>.js (src/pixels/index.ts,
 * its own Rollup entry). It is injected only when /container-scripts sends a
 * config for one of them, so a site without any pays nothing but this file. The
 * module registers `window.DatalyrPixels` (DestinationPixelsModule below).
 *
 * This file decides only whether the module may run at all; the per-platform
 * rules (names, payloads, dedupe ids, other installs on the page) are the
 * module's. Keep it small: it ships to every visitor of every site.
 */
import { isDoNotTrackEnabled, isGlobalPrivacyControlEnabled } from './utils';

export const PIXELS_MODULE_BASE = 'https://track.datalyr.com';
export const PIXELS_GLOBAL = 'DatalyrPixels';
/** Contract version between dl.js and the module; bump on a breaking change. */
export const PIXELS_API = 1;
/** Platforms the module serves. */
export const DESTINATION_PIXEL_PLATFORMS = ['applovin'] as const;
export type DestinationPixelPlatform = typeof DESTINATION_PIXEL_PLATFORMS[number];

/** Outcome of a platform's one-time load decision. */
export type PixelLoadStatus =
  | 'loaded'     // our pixel is initialized: events may be sent
  | 'companion'  // another install already runs this pixel: never send through it
  | 'blocked'    // ruled out for this page (config, account type): never retry
  | 'retry';     // consent was not there when it decided: decide again later

export interface PixelLoadContext {
  /** Shopify's inline web-pixel config entries for this page (container.ts reads them). */
  readShopifyPixels: () => unknown[];
  /** The full gate (consent, DNT / GPC / US opt-out); re-checked after any wait. */
  allowed: () => boolean;
  log: (...args: unknown[]) => void;
}

export interface PixelEvent {
  /** The DATALYR event name as tracked. */
  name: string;
  /** Sanitized properties (snapshot at track time). */
  properties: Record<string, unknown>;
  /** The DATALYR event_id the ingested copy carries. */
  eventId?: string;
  /** Identified email (plain); a module hashes it the platform's way, if it uses it. */
  email?: string | null;
}

export interface DestinationPixelsModule {
  api: number;
  version: string;
  load(platform: string, config: unknown, ctx: PixelLoadContext): Promise<PixelLoadStatus>;
  track(platform: string, config: unknown, event: PixelEvent, ctx: { allowed: () => boolean }): Promise<boolean>;
  /** Our pixel for this platform is initialized and still the only install on the page. */
  active?(platform: string): boolean;
}

/** Versioned, immutable module URL. */
export function pixelsModuleUrl(sdkVersion: string): string {
  const version = /^\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/i.test(sdkVersion) ? sdkVersion : 'latest';
  return `${PIXELS_MODULE_BASE}/dl.pixels.${version}.js`;
}

/**
 * A US privacy opt-out in the page: an IAB us_privacy string whose third
 * character is Y ("1YYN"), from the __uspapi CMP or the `usprivacy` cookie.
 * The sender suppresses on the same pattern (/^1.Y/).
 */
export function usPrivacyOptOut(): boolean {
  const optedOut = (value: unknown) => typeof value === 'string' && /^1.Y/i.test(value.trim());
  try {
    const api = (window as any).__uspapi;
    if (typeof api === 'function') {
      let answer: unknown;
      api('getUSPData', 1, (data: any, ok: boolean) => { if (ok !== false) answer = data?.uspString; });
      if (optedOut(answer)) return true;
    }
  } catch { /* a broken CMP is no signal */ }
  try {
    const match = /(?:^|;\s*)usprivacy=([^;]*)/i.exec(document.cookie || '');
    if (match && optedOut(decodeURIComponent(match[1]))) return true;
  } catch { /* cookies unreadable */ }
  return false;
}

/**
 * Browser privacy signals a destination pixel always honors, whatever the
 * site's respectDoNotTrack / respectGlobalPrivacyControl settings: DNT and GPC
 * (dl.js's fingerprint.dnt flag, explicit navigator.globalPrivacyControl too)
 * and a US privacy opt-out. Any error counts as a signal.
 */
export function destinationPrivacyOptOut(): boolean {
  try {
    return isDoNotTrackEnabled() || isGlobalPrivacyControlEnabled() || usPrivacyOptOut();
  } catch {
    return true;
  }
}

/** Injects dl.pixels.<v>.js once per page and resolves with the registered module (or null). */
export class DestinationPixelsLoader {
  private pending: Promise<DestinationPixelsModule | null> | null = null;

  constructor(private readonly sdkVersion: string, private readonly timeoutMs = 10000) {}

  get(): Promise<DestinationPixelsModule | null> {
    const ready = registeredPixelsModule();
    if (ready) return Promise.resolve(ready);
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve) => {
      if (typeof document === 'undefined') { resolve(null); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(registeredPixelsModule());
      };
      try {
        const script = document.createElement('script');
        script.src = pixelsModuleUrl(this.sdkVersion);
        script.async = true;
        script.dataset.datalyrPixel = 'module';
        // No crossOrigin, as for the replay module (no ACAO on track.datalyr.com).
        script.onload = done;
        script.onerror = done; // blocked (CSP, ad blocker, 404): no pixel, never retried
        timer = setTimeout(done, this.timeoutMs);
        (document.head || document.documentElement).appendChild(script);
      } catch {
        resolve(null);
      }
    });
    return this.pending;
  }
}

export function registeredPixelsModule(): DestinationPixelsModule | null {
  try {
    const module = typeof window !== 'undefined' ? (window as any)[PIXELS_GLOBAL] : null;
    return module && module.api === PIXELS_API && typeof module.load === 'function' && typeof module.track === 'function'
      ? module as DestinationPixelsModule : null;
  } catch {
    return null;
  }
}
