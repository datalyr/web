/**
 * Container Script Manager
 * Loads and manages third-party tracking scripts and pixels
 */

import { storage } from './storage';
import { sha256Hex } from './utils';
import type { SdkRemoteConfig } from './config';

// Meta Pixel reference, verified 2026-09-15:
// https://developers.facebook.com/documentation/meta-pixel/reference
// PageView uses track in the base Pixel implementation as well.
const META_STANDARD_EVENTS = new Set([
  'PageView', 'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'CompleteRegistration',
  'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'InitiateCheckout',
  'Lead', 'Purchase', 'Schedule', 'Search', 'StartTrial', 'SubmitApplication',
  'Subscribe', 'ViewContent',
]);

/**
 * Shopify app pixels ("companion mode").
 *
 * Shopify's own sales-channel apps run the merchant's ad pixels as web pixels:
 *
 * - Facebook & Instagram (Meta): OPEN runtime, i.e. the top page. It loads
 *   fbevents.js into window.fbq, calls
 *   fbq('init', pixelId, {}, { agent: 'shopify_web_pixel' }) and sends
 *   PageView / ViewContent / AddToCart / InitiateCheckout / AddPaymentInfo /
 *   Search / Purchase with Shopify's event ids.
 * - Google & YouTube (apiClientId 1780363): OPEN runtime. It shares
 *   window.gtag / window.dataLayer, configures each id in
 *   configuration.config.google_tag_ids with send_page_view:false and sends its
 *   own page_view and commerce events with send_to.
 * - TikTok (apiClientId 4383523, configuration {"pixelCode"}): STRICT runtime,
 *   a web worker. Nothing of it is visible in the top page.
 *
 * If the container also initialized the same id and sent its own page event,
 * every page view would be counted twice. In companion mode the container
 * does not load or initialize that platform's tag and never sends its page
 * event. It mirrors the other dl.js events only through a single-destination
 * call on a tag the app already set up in the page (fbq trackSingle, gtag
 * send_to, ttq.instance), and skips the browser copy when there is none.
 */
export const SHOPIFY_FACEBOOK_APP_AGENT = 'shopify_web_pixel';
export const SHOPIFY_GOOGLE_APP_CLIENT_ID = 1780363;
export const SHOPIFY_TIKTOK_APP_CLIENT_ID = 4383523;
/** How long a mirrored event waits for the app's tag to have our id set up. */
const COMPANION_WAIT_MS = 10000;
const COMPANION_POLL_MS = 250;
/** Events allowed to wait at once; beyond this the browser copy is skipped (the server copy still sends). */
const COMPANION_MAX_PENDING = 50;
/** Upper bound on waiting for the HTML to finish parsing before deciding on companion mode. */
const COMPANION_DOM_WAIT_MS = 2000;

/** One entry of Shopify's inline webPixelsConfigList. */
export interface ShopifyWebPixelEntry {
  apiClientId?: number;
  runtimeContext?: string;
  /** Parsed `configuration` (Shopify serializes it as a JSON string). */
  configuration: any;
}

function parseJsonMaybe(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Index of the `]` closing the array that starts at `start`, skipping string contents. */
function closingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Shopify's web pixel config for this page, read from the inline
 * `wpmLoader({ ..., webPixelsConfigList: [...] })` bootstrap in the
 * server-rendered HTML. It is present before any app pixel code has loaded,
 * which is what makes detection safe against the async load order.
 *
 * The list is JSON inside a JS object literal. If it ever stops parsing as
 * JSON, fall back to reading the `configuration` strings alone: apiClientId is
 * then unknown, so only the Meta check (keyed on pixel_type) still matches and
 * Google / TikTok conservatively keep their full behaviour.
 */
export function readShopifyWebPixelsConfig(doc?: Document): ShopifyWebPixelEntry[] {
  const entries: ShopifyWebPixelEntry[] = [];
  try {
    const root = doc || (typeof document !== 'undefined' ? document : undefined);
    if (!root) return entries;
    const scripts = root.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      if (script.src) continue;
      const text = script.text || script.textContent || '';
      const key = text.indexOf('webPixelsConfigList');
      if (key === -1) continue;
      const open = text.indexOf('[', key);
      const close = open === -1 ? -1 : closingBracket(text, open);
      const list = close === -1 ? undefined : parseJsonMaybe(text.slice(open, close + 1));
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (!entry || typeof entry !== 'object') continue;
          entries.push({
            apiClientId: typeof entry.apiClientId === 'number' ? entry.apiClientId : undefined,
            runtimeContext: typeof entry.runtimeContext === 'string' ? entry.runtimeContext : undefined,
            configuration: parseJsonMaybe(entry.configuration),
          });
        }
        continue;
      }
      const pattern = /"configuration"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        entries.push({ configuration: parseJsonMaybe(parseJsonMaybe(`"${match[1]}"`)) });
      }
    }
  } catch { /* DOM access failed: no signal */ }
  return entries;
}

/** Facebook & Instagram app: a facebook_pixel web pixel for this pixel id. */
export function shopifyPageConfiguresFacebookAppPixel(pixelId: string, doc?: Document, entries?: ShopifyWebPixelEntry[]): boolean {
  const wanted = String(pixelId || '').trim();
  if (!wanted) return false;
  return (entries || readShopifyWebPixelsConfig(doc)).some(({ configuration }) =>
    configuration?.pixel_type === 'facebook_pixel' && String(configuration.pixel_id ?? '').trim() === wanted);
}

/** Google & YouTube app: our tag id is one of the ids it configures. */
export function shopifyPageConfiguresGoogleAppTag(tagId: string, doc?: Document, entries?: ShopifyWebPixelEntry[]): boolean {
  const wanted = String(tagId || '').trim();
  if (!wanted) return false;
  return (entries || readShopifyWebPixelsConfig(doc)).some(({ apiClientId, configuration }) => {
    if (apiClientId !== SHOPIFY_GOOGLE_APP_CLIENT_ID) return false;
    const inner = parseJsonMaybe(configuration?.config);
    const ids: unknown[] = Array.isArray(inner?.google_tag_ids) && inner.google_tag_ids.length > 0
      ? inner.google_tag_ids
      : [inner?.pixel_id];
    return ids.some((id) => String(id ?? '').trim() === wanted);
  });
}

/** TikTok app: its pixelCode is our pixel code. */
export function shopifyPageConfiguresTikTokAppPixel(pixelCode: string, doc?: Document, entries?: ShopifyWebPixelEntry[]): boolean {
  const wanted = String(pixelCode || '').trim();
  if (!wanted) return false;
  return (entries || readShopifyWebPixelsConfig(doc)).some(({ apiClientId, configuration }) =>
    apiClientId === SHOPIFY_TIKTOK_APP_CLIENT_ID && String(configuration?.pixelCode ?? '').trim() === wanted);
}

/** Array-like command queue entries (fbq.queue, dataLayer) as plain arrays. */
function queuedCalls(queue: any): unknown[][] {
  try {
    if (!queue || typeof queue.length !== 'number') return [];
    const calls: unknown[][] = [];
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry && typeof entry === 'object' && typeof entry.length === 'number') {
        calls.push(Array.prototype.slice.call(entry));
      }
    }
    return calls;
  } catch {
    return [];
  }
}

/**
 * Pixel records fbevents exposes once it has loaded: `fbq.instance.pixelsByID`
 * and `fbq.getState().pixels` (checked against fbevents.js: each record has
 * `id` and the `agent` passed to init). Returns null when neither can be read.
 */
function fbqLoadedPixels(fbq: any): Array<Record<string, unknown>> | null {
  let pixels: Array<Record<string, unknown>> | null = null;
  try {
    const byId = fbq?.instance?.pixelsByID;
    if (byId && typeof byId === 'object') {
      pixels = Object.keys(byId).map((id) => ({ id, ...(byId[id] || {}) }));
    }
  } catch { /* internals changed */ }
  try {
    const state = typeof fbq?.getState === 'function' ? fbq.getState() : null;
    if (state && Array.isArray(state.pixels)) {
      pixels = (pixels || []).concat(state.pixels.filter((p: unknown) => p && typeof p === 'object'));
    }
  } catch { /* internals changed */ }
  return pixels;
}

/** Someone already initialized (or queued the init of) this pixel on fbq. */
function fbqHasPixel(fbq: any, pixelId: string): boolean {
  if (typeof fbq !== 'function') return false;
  const wanted = String(pixelId);
  if (queuedCalls(fbq.queue).some((call) => call[0] === 'init' && String(call[1]) === wanted)) return true;
  return !!fbqLoadedPixels(fbq)?.some((pixel) => String(pixel.id) === wanted);
}

/**
 * Runtime signal (fallback when the page config is unavailable): the app has
 * already queued or performed its init of this pixel on window.fbq, which it
 * tags with agent "shopify_web_pixel", or has set its sandbox context for it.
 * Only visible once the app's pixel code has run.
 */
export function shopifyFacebookAppPixelRunning(fbq: any, pixelId: string): boolean {
  const wanted = String(pixelId || '').trim();
  if (!wanted || typeof fbq !== 'function') return false;
  for (const call of queuedCalls(fbq.queue)) {
    const [command, first, third, fourth] = [call[0], call[1], call[2], call[3]] as any[];
    if (command === 'init' && String(first) === wanted && fourth?.agent === SHOPIFY_FACEBOOK_APP_AGENT) return true;
    if (command === 'set' && first === 'shopifySandboxContext' && String(third?.pixelId) === wanted) return true;
  }
  const loaded = fbqLoadedPixels(fbq);
  return !!loaded?.some((pixel) => String(pixel.id) === wanted && pixel.agent === SHOPIFY_FACEBOOK_APP_AGENT);
}

/**
 * Whether a trackSingle for this pixel would be accepted right now: fbq exists
 * and the pixel's init is either queued ahead of us (stub) or done (loaded).
 * fbevents drops trackSingle for a pixel it has not initialized
 * (PIXEL_NOT_INITIALIZED). When its internals cannot be read, assume ready.
 */
function companionFbqReady(fbq: any, pixelId: string): boolean {
  if (typeof fbq !== 'function') return false;
  const wanted = String(pixelId);
  if (queuedCalls(fbq.queue).some((call) => call[0] === 'init' && String(call[1]) === wanted)) return true;
  if (typeof fbq.callMethod !== 'function') return false; // stub, init not queued yet
  const loaded = fbqLoadedPixels(fbq);
  return loaded === null || loaded.some((pixel) => String(pixel.id) === wanted);
}

/** The Google app's gtag has configured our tag id (so send_to reaches it). */
function companionGtagReady(tagId: string): boolean {
  const host = window as any;
  if (typeof host.gtag !== 'function') return false;
  try {
    if (host.google_tag_manager && host.google_tag_manager[tagId]) return true;
  } catch { /* ignore */ }
  return queuedCalls(host.dataLayer).some((call) => call[0] === 'config' && String(call[1]) === tagId);
}

function isPageEvent(eventName: string): boolean {
  const name = String(eventName).toLowerCase();
  return name === 'pageview' || name === 'page_view';
}

function waitForDomContentLoaded(timeoutMs: number): Promise<void> {
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

/**
 * Identity snapshot read at the moment a third-party pixel initializes.
 * Aligns the browser Pixel's advanced matching with what CAPI sends server-side
 * (meta.js shovels all of {user_id, visitor_id, anonymous_id} into the CAPI
 * external_id array) — so any one of those hashes coincides between surfaces.
 *
 * `externalId` should be the SDK's distinct_id (user_id when identified, else
 * anonymous_id). `email` is only populated after identify(); when present, lets
 * the Pixel match on `em` too.
 */
export interface PixelIdentity {
  externalId?: string | null;
  email?: string | null;
}

export interface ContainerScript {
  id: string;
  name: string;
  type: 'inline' | 'external' | 'pixel';
  content: string; // Script content or URL
  trigger: 'page_load' | 'dom_ready' | 'window_load' | 'custom';
  frequency: 'always' | 'once_per_page' | 'once_per_session';
  enabled: boolean;
  conditions?: Array<{
    type: string;
    operator: string;
    value: any;
  }>;
  settings?: {
    async?: boolean;
    defer?: boolean;
    integrity?: string;
    crossorigin?: string;
  };
}

export interface PixelConfig {
  meta?: {
    enabled: boolean;
    pixel_id: string;
    enhanced_conversions?: boolean;
  };
  google?: {
    enabled: boolean;
    tag_id: string;
    enhanced_conversions?: boolean;
  };
  tiktok?: {
    enabled: boolean;
    pixel_id: string;
  };
  whop?: {
    enabled: boolean;
    company_id: string;
  };
}

export class ContainerManager {
  private scripts: ContainerScript[] = [];
  private loadedScripts = new Set<string>();
  private sessionLoadedScripts = new Set<string>();
  private pixels: PixelConfig | null = null;
  /** SDK runtime config from the /container-scripts `config` envelope (the
   *  dashboard sdk_config + server-computed defaults). undefined if the worker
   *  doesn't send it — caller then falls back to built-in defaults. */
  private remoteConfig?: SdkRemoteConfig;
  private workspaceId: string;
  private endpoint: string;
  private debug: boolean;
  private initialized = false;
  private disposed = false;
  private sandboxedIframes: HTMLIFrameElement[] = []; // FIXED (ISSUE-02): Track iframes for cleanup
  private iframeCleanupTimeouts = new Map<HTMLIFrameElement, number>(); // FIXED (ISSUE-02): Track cleanup timeouts
  private messageHandler: ((event: MessageEvent) => void) | null = null; // FIXED (ISSUE-02): Track message listener
  // Lazy identity getter so the Pixel can read the SDK's distinct_id / email at
  // the moment of fbq('init'), after the /container-scripts roundtrip has
  // resolved and after any pre-init identify() has updated user state. Reading
  // through a callback avoids snapshotting stale identity at construction.
  private getIdentity?: () => PixelIdentity | undefined;
  private canForward?: () => boolean;
  /** Receives the dashboard config as soon as it is read, BEFORE any pixel
   *  loads, so the SDK can fold in privacyMode / DNT / GPC and the canForward
   *  gate below sees them. */
  private onRemoteConfig?: (config: SdkRemoteConfig | undefined) => void;
  /** Install platform (data-platform). */
  private platform?: string;
  /** In-flight or completed init(); trackToPixels waits on it so events tracked
   *  while the container is still initializing are forwarded, not dropped. */
  private initPromise: Promise<void> | null = null;
  /** Shopify's own app runs this platform's tag for the same id on this page. */
  private companion = { meta: false, google: false, tiktok: false };
  private companionWaits = new Map<string, { promise: Promise<any>; resolve: (value: any) => void; timer: ReturnType<typeof setInterval> }>();
  private companionPending = 0;

  constructor(options: {
    workspaceId: string;
    endpoint?: string;
    debug?: boolean;
    getIdentity?: () => PixelIdentity | undefined;
    canForward?: () => boolean;
    onRemoteConfig?: (config: SdkRemoteConfig | undefined) => void;
    platform?: string;
  }) {
    this.workspaceId = options.workspaceId;
    // Container scripts use the same endpoint as tracking (ingest)
    this.endpoint = options.endpoint || 'https://ingest.datalyr.com';
    this.debug = options.debug || false;
    this.getIdentity = options.getIdentity;
    this.canForward = options.canForward;
    this.onRemoteConfig = options.onRemoteConfig;
    this.platform = options.platform;

    // Load session scripts from storage
    const sessionScripts = storage.get('dl_session_scripts', []);
    this.sessionLoadedScripts = new Set(sessionScripts);

    // FIXED (ISSUE-02): Set up postMessage listener for iframe cleanup
    this.messageHandler = (event: MessageEvent) => {
      if (event.data && event.data.type === 'datalyr_script_complete') {
        const scriptId = event.data.scriptId;
        this.log('Received script completion signal:', scriptId);

        // Find and clean up the corresponding iframe
        const iframe = this.sandboxedIframes.find(
          iframe => iframe.dataset.datalyrScript === scriptId
        );

        if (iframe) {
          this.cleanupIframe(iframe);
        }
      }
    };

    window.addEventListener('message', this.messageHandler);
  }

  /**
   * Initialize container and load scripts
   */
  private forwardingAllowed(): boolean {
    if (this.disposed) return false;
    try { return this.canForward ? this.canForward() === true : true; }
    catch { return false; }
  }

  private async readConfiguration(purpose?: 'pixel_forwarding'): Promise<any> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bound headers AND body even when a fetch wrapper ignores AbortSignal.
    // Late responses cannot resume callers after the deadline has rejected.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Container configuration deadline exceeded'));
        controller?.abort();
      }, 3000);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(`${this.endpoint}/container-scripts`, {
            method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Container-Version': '1.0' },
            body: JSON.stringify({ workspaceId: this.workspaceId, ...(purpose ? { purpose } : {}) }),
            signal: controller?.signal,
          });
          if (!response.ok) throw new Error(`Failed to fetch container scripts: ${response.status}`);
          return await response.json();
        })(),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Initialize the container. Concurrent calls share one run, so the Meta pixel
   * is never initialized twice; a run that did not complete (policy read
   * failed, consent withdrawn) can be retried by a later call.
   */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (this.initialized || !this.forwardingAllowed()) return Promise.resolve();
    const run = this.runInit().finally(() => {
      if (!this.initialized && this.initPromise === run) this.initPromise = null;
    });
    this.initPromise = run;
    return run;
  }

  private async runInit(): Promise<void> {
    try {
      const data = await this.readConfiguration();
      this.remoteConfig = (data?.config && typeof data.config === 'object') ? data.config : undefined;
      // Hand the dashboard config to the SDK first: a dashboard privacyMode
      // 'strict', respectDoNotTrack or respectGlobalPrivacyControl must be in
      // force before the gate below decides whether any pixel may load.
      try { this.onRemoteConfig?.(this.remoteConfig); } catch (error) { this.log('Remote config hook failed:', error); }
      if (!this.forwardingAllowed()) return;
      
      // Store scripts and pixels.
      this.scripts = data.scripts || [];
      this.pixels = data.pixels || null;
      
      // Initialize pixels if configured. Awaited so advanced-matching hashes
      // are resolved before the first dl.track() flushes through trackToPixels
      // (otherwise fbq('init') would lag fbq('track') in fast-path tracks).
      if (this.pixels) {
        await this.initializePixels();
      }
      
      if (!this.forwardingAllowed()) return;
      // Load scripts based on trigger
      this.loadScriptsByTrigger('page_load');
      
      // Setup DOM ready listener
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          this.loadScriptsByTrigger('dom_ready');
        });
      } else {
        this.loadScriptsByTrigger('dom_ready');
      }
      
      // Setup window load listener
      window.addEventListener('load', () => {
        this.loadScriptsByTrigger('window_load');
      });
      
      this.initialized = true;
      this.log('Container manager initialized with', this.scripts.length, 'scripts');
      
    } catch (error) {
      this.log('Error initializing container:', error);
    }
  }

  /**
   * The SDK runtime config delivered by /container-scripts, or undefined if the
   * response omitted it. The SDK merges this under explicit init() options.
   */
  getRemoteConfig(): SdkRemoteConfig | undefined {
    return this.remoteConfig;
  }

  /**
   * Load scripts by trigger type
   */
  private loadScriptsByTrigger(trigger: string): void {
    if (!this.forwardingAllowed()) return;
    const scriptsToLoad = this.scripts.filter(script => 
      script.enabled && 
      script.trigger === trigger &&
      this.shouldLoadScript(script)
    );
    
    scriptsToLoad.forEach(script => this.loadScript(script));
  }

  /**
   * Check if script should be loaded based on frequency and conditions
   */
  private shouldLoadScript(script: ContainerScript): boolean {
    // Check frequency
    if (script.frequency === 'once_per_page' && this.loadedScripts.has(script.id)) {
      return false;
    }
    
    if (script.frequency === 'once_per_session' && this.sessionLoadedScripts.has(script.id)) {
      return false;
    }
    
    // Check conditions
    if (script.conditions && script.conditions.length > 0) {
      return this.evaluateConditions(script.conditions);
    }
    
    return true;
  }

  /**
   * Evaluate script conditions
   */
  private evaluateConditions(conditions: any[]): boolean {
    return conditions.every(condition => {
      try {
        const { type, operator, value } = condition;
        
        switch (type) {
          case 'url_path':
            return this.evaluateStringCondition(window.location.pathname, operator, value);
          case 'url_host':
            return this.evaluateStringCondition(window.location.hostname, operator, value);
          case 'url_parameter':
            const params = new URLSearchParams(window.location.search);
            return this.evaluateStringCondition(params.get(condition.parameter) || '', operator, value);
          case 'referrer':
            return this.evaluateStringCondition(document.referrer, operator, value);
          case 'device_type':
            const isMobile = /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent);
            return this.evaluateStringCondition(isMobile ? 'mobile' : 'desktop', operator, value);
          default:
            return true;
        }
      } catch {
        return false;
      }
    });
  }

  /**
   * Evaluate string condition
   */
  private evaluateStringCondition(actual: string, operator: string, expected: string): boolean {
    switch (operator) {
      case 'equals':
        return actual === expected;
      case 'not_equals':
        return actual !== expected;
      case 'contains':
        return actual.includes(expected);
      case 'not_contains':
        return !actual.includes(expected);
      case 'starts_with':
        return actual.startsWith(expected);
      case 'ends_with':
        return actual.endsWith(expected);
      case 'matches_regex':
        try {
          return new RegExp(expected).test(actual);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Load a single script
   */
  private loadScript(script: ContainerScript): void {
    try {
      switch (script.type) {
        case 'inline':
          this.loadInlineScript(script);
          break;
        case 'external':
          this.loadExternalScript(script);
          break;
        case 'pixel':
          this.loadPixel(script);
          break;
      }
      
      // Mark as loaded
      this.loadedScripts.add(script.id);
      
      // Update session scripts if needed
      if (script.frequency === 'once_per_session') {
        this.sessionLoadedScripts.add(script.id);
        storage.set('dl_session_scripts', Array.from(this.sessionLoadedScripts));
      }
      
      this.log('Loaded script:', script.name);
      
    } catch (error) {
      this.log('Error loading script:', script.name, error);
    }
  }

  /**
   * Load inline JavaScript in sandboxed iframe
   * SECURITY: User-provided scripts run in isolated context to prevent XSS
   * FIXED (ISSUE-02): Added cleanup mechanism to prevent memory leaks
   */
  private loadInlineScript(script: ContainerScript): void {
    // SECURITY FIX: Run in sandboxed iframe instead of main page context
    // This prevents access to parent window, cookies, and localStorage

    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.setAttribute('sandbox', 'allow-scripts'); // Minimal permissions
    iframe.dataset.datalyrScript = script.id;

    // FIXED (ISSUE-02): Track iframe for cleanup
    this.sandboxedIframes.push(iframe);

    // Create isolated script context with completion signal
    const iframeDoc = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body>
          <script>
            // User-provided script runs here in isolation
            try {
              ${script.content}
            } catch (error) {
              console.error('[Datalyr Container] Script execution error:', error);
            }

            // FIXED (ISSUE-02): Signal completion for cleanup
            // Scripts have 5 seconds to execute before iframe is removed
            setTimeout(function() {
              try {
                parent.postMessage({ type: 'datalyr_script_complete', scriptId: '${script.id}' }, '*');
              } catch (e) {
                // Ignore postMessage errors from sandbox
              }
            }, 5000);
          </script>
        </body>
      </html>
    `;

    document.body.appendChild(iframe);

    // Write content to iframe (safe because sandbox prevents parent access)
    if (iframe.contentDocument) {
      iframe.contentDocument.open();
      iframe.contentDocument.write(iframeDoc);
      iframe.contentDocument.close();
    }

    // FIXED (ISSUE-02): Remove iframe after execution (30 seconds max as fallback)
    // If script completes in 5s, postMessage will trigger early cleanup
    const timeoutId = window.setTimeout(() => {
      this.cleanupIframe(iframe);
    }, 30000);

    // Store timeout ID for cleanup
    this.iframeCleanupTimeouts.set(iframe, timeoutId);

    this.log('Loaded inline script in sandbox:', script.id);
  }

  /**
   * Clean up a sandboxed iframe
   * FIXED (ISSUE-02): Prevents memory leaks from iframe accumulation
   */
  private cleanupIframe(iframe: HTMLIFrameElement): void {
    try {
      // FIXED (ISSUE-02): Clear pending timeout to prevent duplicate cleanup
      const timeoutId = this.iframeCleanupTimeouts.get(iframe);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.iframeCleanupTimeouts.delete(iframe);
      }

      // Remove from tracking array
      const index = this.sandboxedIframes.indexOf(iframe);
      if (index > -1) {
        this.sandboxedIframes.splice(index, 1);
      }

      // Remove from DOM
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
        this.log('Cleaned up sandboxed iframe:', iframe.dataset.datalyrScript);
      }
    } catch (error) {
      this.log('Error cleaning up iframe:', error);
    }
  }

  /**
   * Clean up all sandboxed iframes
   * FIXED (ISSUE-02): Called on SDK destroy to prevent memory leaks
   */
  public cleanupAllIframes(): void {
    // Cancel pending policy decisions as well as sandboxed scripts.
    this.disposed = true;
    // Release events waiting for a Shopify app tag; they are not sent.
    Array.from(this.companionWaits.keys()).forEach((key) => this.finishCompanionWait(key, null));
    // Clean up all iframes
    const iframes = [...this.sandboxedIframes]; // Copy array since we're modifying it
    iframes.forEach(iframe => this.cleanupIframe(iframe));

    // FIXED (ISSUE-02): Remove message listener to prevent memory leak
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    // Clear any remaining timeouts
    this.iframeCleanupTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    this.iframeCleanupTimeouts.clear();

    this.log(`Cleaned up ${iframes.length} sandboxed iframes`);
  }

  /**
   * Load external JavaScript with SRI validation
   * SECURITY (Phase 1.2): SRI is now REQUIRED for external scripts
   */
  private loadExternalScript(script: ContainerScript): void {
    // Validate URL before loading
    if (!this.isValidScriptUrl(script.content)) {
      this.log('Blocked invalid script URL:', script.content);
      return;
    }

    // SECURITY FIX: Require SRI (Subresource Integrity) for external scripts
    if (!script.settings?.integrity) {
      console.error(
        `[Datalyr Container] SECURITY: External script "${script.id}" blocked - missing SRI hash.\n` +
        `All external scripts MUST include an integrity hash to prevent CDN compromise attacks.\n` +
        `Generate SRI hash at: https://www.srihash.org/\n` +
        `Example: { integrity: "sha384-..." }`
      );
      return;
    }

    const scriptElement = document.createElement('script');
    scriptElement.src = script.content;
    scriptElement.dataset.datalyrScript = script.id;

    // Apply settings
    if (script.settings) {
      scriptElement.integrity = script.settings.integrity; // REQUIRED
      scriptElement.crossOrigin = script.settings.crossorigin || 'anonymous'; // Required for SRI

      if (script.settings.async !== false) scriptElement.async = true;
      if (script.settings.defer) scriptElement.defer = true;
    } else {
      // This should never happen now that integrity is required
      scriptElement.async = true;
    }

    document.head.appendChild(scriptElement);
  }

  /**
   * Load tracking pixel
   */
  private loadPixel(script: ContainerScript): void {
    const img = new Image();
    img.src = script.content;
    img.style.display = 'none';
    img.dataset.datalyrPixel = script.id;
    document.body.appendChild(img);
  }

  /** Initialize configured third-party pixels in the merchant's page context. */
  private async initializePixels(): Promise<void> {
    if (!this.pixels || !this.forwardingAllowed()) return;

    // Shopify's own apps may already run these tags for the same ids.
    const shopifyPixels = await this.readShopifyAppPixels();
    if (!this.pixels || !this.forwardingAllowed()) return;

    // Initialize Meta Pixel
    if (this.pixels.meta?.enabled && this.pixels.meta.pixel_id) {
      const pixelId = String(this.pixels.meta.pixel_id);
      if (shopifyPageConfiguresFacebookAppPixel(pixelId, undefined, shopifyPixels)
        || shopifyFacebookAppPixelRunning((window as any).fbq, pixelId)) {
        // Loading fbevents, init or our own PageView would double-count; events
        // are mirrored through the app's fbq instead (see trackToPixels).
        this.companion.meta = true;
        this.log('Meta Pixel companion mode: Shopify Facebook & Instagram app runs pixel', pixelId);
      } else {
        await this.initializeMetaPixel(this.pixels.meta);
      }
    }

    if (!this.forwardingAllowed()) return;
    // Initialize Google Tag
    if (this.pixels.google?.enabled && this.pixels.google.tag_id) {
      if (shopifyPageConfiguresGoogleAppTag(String(this.pixels.google.tag_id), undefined, shopifyPixels)) {
        // No gtag.js load and no config (config sends page_view); events are
        // mirrored with send_to through the app's gtag.
        this.companion.google = true;
        this.log('Google Tag companion mode: Shopify Google & YouTube app runs tag', this.pixels.google.tag_id);
      } else {
        this.initializeGoogleTag(this.pixels.google);
      }
    }

    // Initialize TikTok Pixel
    if (this.pixels.tiktok?.enabled && this.pixels.tiktok.pixel_id) {
      if (shopifyPageConfiguresTikTokAppPixel(String(this.pixels.tiktok.pixel_id), undefined, shopifyPixels)) {
        // No ttq.load / ttq.page(); the app sends the page view from its worker.
        this.companion.tiktok = true;
        this.log('TikTok Pixel companion mode: Shopify TikTok app runs pixel', this.pixels.tiktok.pixel_id);
      } else {
        this.initializeTikTokPixel(this.pixels.tiktok);
      }
    }

    // The Whop Pixel needs only the merchant's public company ID. Loading it
    // here lets Whop link this external-site visitor to a later hosted or
    // embedded Whop checkout without a Datalyr visitor_id in checkout metadata.
    if (this.pixels.whop?.enabled && this.pixels.whop.company_id) {
      this.initializeWhopPixel(this.pixels.whop);
    }
  }

  /** Initialize Whop's official first-party attribution pixel. */
  private initializeWhopPixel(config: { company_id: string }): void {
    try {
      const host = window as any;
      if (!host.whop) {
        const queue: any = host.whop = {
          q: [],
          t: Date.now(),
          s: [],
          o: 'https://t.whop.tw',
          track: function(...args: any[]) {
            queue.q.push([Date.now(), ...args]);
          },
          setScope: function(...args: any[]) {
            queue.s = args.filter((value: unknown) => typeof value === 'string');
            queue.q.push([Date.now(), 'setScope', ...queue.s]);
          },
          scope: function(...scope: any[]) {
            return {
              track: function(...args: any[]) {
                queue.q.push([Date.now(), ...args, { __scope: scope }]);
              },
            };
          },
        };
        const script = document.createElement('script');
        script.async = true;
        script.src = 'https://t.whop.tw/s.js';
        const firstScript = document.getElementsByTagName('script')[0];
        firstScript?.parentNode?.insertBefore(script, firstScript);
        if (!firstScript) document.head.appendChild(script);
      }

      if (typeof host.whop?.setScope !== 'function') {
        throw new Error('Existing window.whop does not expose setScope');
      }
      host.whop.setScope(config.company_id);
      this.log('Whop Pixel initialized:', config.company_id);
    } catch (error) {
      this.log('Error initializing Whop Pixel:', error);
    }
  }

  /**
   * Initialize Meta (Facebook) Pixel
   *
   * Async because we resolve SHA-256 hashes for advanced matching (Meta's
   * `external_id` / `em`) before calling fbq('init'). Aligning the hashes the
   * browser Pixel sends with what CAPI sends (meta.js shovels user_id /
   * visitor_id / anonymous_id into external_id[], and `em` is sha256 of the
   * lowercased email) is the dedup-quality lift the CAPI side can't fix alone.
   */
  private async initializeMetaPixel(config: any): Promise<void> {
    try {
      const pixelId = String(config.pixel_id);
      // Build advanced-matching object. Skipped silently if Web Crypto isn't
      // available — Pixel still initializes, just without advanced matching.
      // Anonymous_id is stable across the session and always present, so we
      // never need to re-init on identify(): CAPI carries both anonymous_id
      // AND user_id in its external_id[] array, so either side matching one
      // hash slot is enough to dedupe.
      const advancedMatching: Record<string, string> = {};
      const identity = this.getIdentity?.();
      if (identity?.externalId) {
        const hash = await sha256Hex(String(identity.externalId));
        if (hash) advancedMatching.external_id = hash;
      }
      if (identity?.email) {
        const hash = await sha256Hex(String(identity.email).toLowerCase().trim());
        if (hash) advancedMatching.em = hash;
      }

      if (!this.forwardingAllowed()) return;
      // A pixel someone else (theme code, a tag manager) already initialized is
      // theirs as much as ours: leave its broadcast behaviour alone.
      const initializedByOthers = fbqHasPixel((window as any).fbq, pixelId);
      // Load Meta Pixel script
      (function(f: any, b: any, e: any, v: any, n?: any, t?: any, s?: any) {
        if (f.fbq) return;
        n = f.fbq = function() {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n;
        n.loaded = !0;
        n.version = '2.0';
        n.queue = [];
        t = b.createElement(e);
        t.async = !0;
        t.src = v;
        s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t, s);
      })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

      // Turn off Meta's automatic event detection (button clicks, page
      // metadata) for this pixel. Those browser events carry no eventID, so
      // they can never dedupe against CAPI. Must be queued BEFORE init.
      (window as any).fbq('set', 'autoConfig', false, pixelId);

      // Initialize pixel only — do NOT fire PageView here. The SDK's own pageview
      // tracking (track('pageview')) routes through trackToPixels and fires a single
      // mapped PageView with a shared eventID. Firing it again here produced TWO
      // PageViews per load (one un-deduped). Note: if the host app disables pageview
      // tracking entirely, no PageView is sent — which is the correct outcome.
      if (Object.keys(advancedMatching).length > 0) {
        (window as any).fbq('init', pixelId, advancedMatching);
        this.log('Meta Pixel initialized with advanced matching:', pixelId, Object.keys(advancedMatching));
      } else {
        (window as any).fbq('init', pixelId);
        this.log('Meta Pixel initialized (no advanced matching):', pixelId);
      }

      // fbevents sends a plain fbq('track') — and a Shopify app's
      // trackShopify — to EVERY pixel initialized on window.fbq, skipping only
      // pixels marked trackSingleOnly. Mark ours (fbevents accepts this only
      // after init) so another pixel's events, carrying ids our CAPI never
      // sends, cannot land on it; our own events go out with trackSingle.
      if (!initializedByOthers) {
        (window as any).fbq('set', 'trackSingleOnly', true, pixelId);
      }
    } catch (error) {
      this.log('Error initializing Meta Pixel:', error);
    }
  }

  /**
   * Shopify web pixel config for this page. On a Shopify storefront whose HTML
   * is still parsing (a synchronous install placed above Shopify's header
   * scripts), wait briefly so the config script has been parsed.
   */
  private async readShopifyAppPixels(): Promise<ShopifyWebPixelEntry[]> {
    const entries = readShopifyWebPixelsConfig();
    if (entries.length > 0 || typeof document === 'undefined' || document.readyState !== 'loading') return entries;
    if (!this.isShopifyStorefront()) return entries;
    await waitForDomContentLoaded(COMPANION_DOM_WAIT_MS);
    return readShopifyWebPixelsConfig();
  }

  /** data-platform="shopify", or a Shopify storefront reached by a plain snippet. */
  private isShopifyStorefront(): boolean {
    if (this.platform === 'shopify') return true;
    try { return Boolean((window as any).Shopify); } catch { return false; }
  }

  /** True when the Meta pixel is owned by Shopify's Facebook & Instagram app on this page. */
  isMetaCompanionMode(): boolean {
    return this.companion.meta;
  }

  /** Which platforms run in companion mode (Shopify's own app owns the tag). */
  getCompanionModes(): { meta: boolean; google: boolean; tiktok: boolean } {
    return { ...this.companion };
  }

  /**
   * Resolve `probe()` once it returns a value, or null after COMPANION_WAIT_MS.
   * Waiting events for one platform share one poller.
   */
  private awaitCompanion<T>(key: string, probe: () => T | null): Promise<T | null> {
    const now = probe();
    if (now) return Promise.resolve(now);
    const existing = this.companionWaits.get(key);
    if (existing) return existing.promise;
    let ticks = 0;
    const maxTicks = Math.ceil(COMPANION_WAIT_MS / COMPANION_POLL_MS);
    let resolve!: (value: any) => void;
    const promise = new Promise<T | null>((done) => { resolve = done; });
    const timer = setInterval(() => {
      ticks++;
      const value = this.disposed ? null : probe();
      if (value || this.disposed || ticks >= maxTicks) this.finishCompanionWait(key, value);
    }, COMPANION_POLL_MS);
    this.companionWaits.set(key, { promise, resolve, timer });
    return promise;
  }

  private finishCompanionWait(key: string, value: any): void {
    const wait = this.companionWaits.get(key);
    if (!wait) return;
    clearInterval(wait.timer);
    this.companionWaits.delete(key);
    wait.resolve(value);
  }

  /**
   * Companion mode: deliver one event to our id through the Shopify app's tag.
   *
   * - The page event is never sent: the app already sends it for this id.
   * - Delivery is single-destination (fbq trackSingle, gtag send_to): the
   *   app's tag may carry other ids that never get our server copy.
   * - When the app's tag (or its setup of our id) is not there yet, wait a
   *   bounded time rather than drop: the app loads after page load, so an
   *   event tracked early would otherwise never get a browser copy. After the
   *   wait the browser copy is skipped; the server event is unaffected. A late
   *   browser copy is harmless: it carries our event id.
   * - The workspace policy was re-read before the wait; consent is re-checked
   *   after it.
   */
  private async mirrorToCompanion<T>(
    key: string,
    probe: () => T | null,
    send: (tag: T) => void,
  ): Promise<boolean> {
    if (this.companionPending >= COMPANION_MAX_PENDING) return false;
    this.companionPending++;
    let tag: T | null;
    try {
      tag = await this.awaitCompanion(key, probe);
    } finally {
      this.companionPending--;
    }
    if (!tag || !this.forwardingAllowed()) {
      if (!tag) this.log(`${key} companion mode: app tag not ready; browser copy skipped`);
      return false;
    }
    try {
      send(tag);
      return true;
    } catch (error) {
      this.log(`Error mirroring event to the Shopify ${key} app tag:`, error);
      return false;
    }
  }

  /**
   * Initialize Google Tag
   */
  private initializeGoogleTag(config: any): void {
    try {
      // Load Google Tag script
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${config.tag_id}`;
      document.head.appendChild(script);
      
      // Initialize gtag
      (window as any).dataLayer = (window as any).dataLayer || [];
      function gtag(...args: any[]) {
        (window as any).dataLayer.push(args);
      }
      (window as any).gtag = gtag;
      gtag('js', new Date());
      gtag('config', config.tag_id, {
        allow_enhanced_conversions: config.enhanced_conversions !== false
      });
      
      this.log('Google Tag initialized:', config.tag_id);
    } catch (error) {
      this.log('Error initializing Google Tag:', error);
    }
  }

  /**
   * Initialize TikTok Pixel
   */
  private initializeTikTokPixel(config: any): void {
    try {
      // Load TikTok Pixel script
      (function(w: any, _d: any, t: any) {
        w.TiktokAnalyticsObject = t;
        var ttq = w[t] = w[t] || [];
        ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
        ttq.setAndDefer = function(t: any, e: any) {
          t[e] = function() {
            t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
          };
        };
        for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
        ttq.instance = function(t: any) {
          for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);
          return e;
        };
        ttq.load = function(e: any, n?: any) {
          var i = 'https://analytics.tiktok.com/i18n/pixel/events.js';
          ttq._i = ttq._i || {};
          ttq._i[e] = [];
          ttq._o = ttq._o || {};
          ttq._o[e] = n || {};
          var o = document.createElement('script');
          o.type = 'text/javascript';
          o.async = true;
          o.src = i + '?sdkid=' + e + '&lib=' + t;
          var a = document.getElementsByTagName('script')[0];
          a.parentNode?.insertBefore(o, a);
        };
      })(window, document, 'ttq');
      
      // Initialize pixel
      (window as any).ttq.load(config.pixel_id);
      (window as any).ttq.page();
      
      this.log('TikTok Pixel initialized:', config.pixel_id);
    } catch (error) {
      this.log('Error initializing TikTok Pixel:', error);
    }
  }

  /**
   * Whether the Meta Pixel is configured AND loaded (fbq present) — i.e. a Purchase
   * co-fire via trackToPixels() would actually reach Meta rather than silently no-op.
   * Used by the CC purchase-pixel dedup so its once-per-order guard isn't burned before
   * the pixel is live. (FSR-102)
   */
  hasMetaPixel(): boolean {
    return !!(this.pixels?.meta?.enabled && (window as any).fbq);
  }

  /**
   * Track event to all initialized pixels
   */
  async trackToPixels(eventName: string, properties: any = {}, eventId?: string): Promise<string[]> {
    if (!this.forwardingAllowed() || eventName.startsWith('$')) return [];
    // Snapshot before awaiting: caller mutations must not change the queued event.
    const sanitizedEventName = this.sanitizeEventName(eventName);
    const sanitizedProperties = this.sanitizeProperties(properties);
    // An event tracked while init() is still running (e.g. the pageview released
    // when Shopify consent resolves right after the container was created) is
    // forwarded once the pixels are initialized instead of being dropped.
    if (this.initPromise && !this.initialized) {
      await this.initPromise;
      if (!this.forwardingAllowed()) return [];
    }
    const initialized = this.pixels;
    if (!initialized) return [];
    // Authorization is request-scoped, never a positive cached decision. Do not
    // execute newly returned scripts or initialize a new destination here.
    const pixels: PixelConfig = { whop: initialized.whop };
    const platforms = ['meta', 'google', 'tiktok'] as const;
    if (platforms.some(platform => initialized[platform]?.enabled === true)) {
      try {
        const data = await this.readConfiguration('pixel_forwarding');
        if (!this.forwardingAllowed()) return [];
        for (const platform of platforms) {
          const prior = initialized[platform];
          const current = data?.pixels?.[platform];
          const id = platform === 'google' ? 'tag_id' : 'pixel_id';
          if (prior?.enabled === true && current?.enabled === true
            && typeof current[id] === 'string' && current[id].length > 0
            && current[id] === (prior as any)[id]) {
            (pixels as any)[platform] = current;
          }
        }
      } catch {
        this.log('Pixel forwarding withheld: current policy unavailable');
        return [];
      }
    }
    if (!this.forwardingAllowed()) return [];
    const host = window as any;
    const delivered = new Set<string>();
    // Companion deliveries may wait for a Shopify app's tag. They run without
    // blocking the other destinations and are awaited before returning.
    const companionDeliveries: Array<Promise<void>> = [];
    const mirror = (platform: string, delivery: Promise<boolean>) => {
      companionDeliveries.push(delivery.catch(() => false).then((ok) => { if (ok) delivered.add(platform); }));
    };

    // Track to Meta Pixel
    if (pixels?.meta?.enabled) {
      try {
        const pixelId = String(pixels.meta.pixel_id);
        const metaEvent = this.resolveMetaEventName(pixels.meta, eventName, sanitizedEventName);
        // Custom names use Meta's custom-event API. This selects the correct
        // transport call; it does not establish eligibility or rename the event.
        // Single-pixel calls only: a plain fbq('track') reaches every pixel on
        // window.fbq, including ones (a Shopify app's) that never get our CAPI copy.
        const method = META_STANDARD_EVENTS.has(metaEvent) ? 'trackSingle' : 'trackSingleCustom';
        // Keep the same event name and ID as CAPI for deduplication.
        const send = (fbq: any) => {
          if (eventId) {
            fbq(method, pixelId, metaEvent, sanitizedProperties, { eventID: eventId });
          } else {
            fbq(method, pixelId, metaEvent, sanitizedProperties);
          }
        };
        if (this.companion.meta) {
          // Shopify's Facebook & Instagram app owns the pixel and sends PageView itself.
          if (metaEvent !== 'PageView') {
            mirror('meta', this.mirrorToCompanion('meta',
              () => (companionFbqReady(host.fbq, pixelId) ? host.fbq : null), send));
          }
        } else if (host.fbq) {
          send(host.fbq);
          delivered.add('meta');
        }
      } catch (error) {
        this.log('Error tracking Meta Pixel event:', error);
      }
    }

    // Track to Google Tag
    if (pixels?.google?.enabled) {
      try {
        if (this.companion.google) {
          // Shopify's Google & YouTube app configured this tag and sends
          // page_view itself; send_to keeps our events off its other ids.
          const tagId = String(pixels.google.tag_id);
          if (!isPageEvent(eventName)) {
            mirror('google', this.mirrorToCompanion('google',
              () => (companionGtagReady(tagId) ? host.gtag : null),
              (gtag: any) => gtag('event', sanitizedEventName, { ...sanitizedProperties, send_to: tagId })));
          }
        } else if (host.gtag) {
          host.gtag('event', sanitizedEventName, sanitizedProperties);
          delivered.add('google');
        }
      } catch (error) {
        this.log('Error tracking Google Tag event:', error);
      }
    }

    // Track to TikTok Pixel
    if (pixels?.tiktok?.enabled) {
      try {
        const tiktokEvent = this.resolveTikTokEventName(pixels.tiktok, eventName, sanitizedEventName);
        if (this.companion.tiktok) {
          // Shopify's TikTok app runs this pixel in a sandboxed worker, so the
          // top page normally has no ttq holding it. Mirror only when one does
          // (e.g. theme code loaded the same pixel), through its single-pixel
          // instance. No wait: the app's own ttq never appears in this page.
          const code = String(pixels.tiktok.pixel_id);
          const ttq = host.ttq;
          if (!isPageEvent(eventName) && ttq && typeof ttq.instance === 'function' && ttq._i && ttq._i[code]) {
            ttq.instance(code).track(tiktokEvent, sanitizedProperties);
            delivered.add('tiktok');
          }
        } else if (host.ttq) {
          host.ttq.track(tiktokEvent, sanitizedProperties);
          delivered.add('tiktok');
        }
      } catch (error) {
        this.log('Error tracking TikTok Pixel event:', error);
      }
    }

    // Whop records checkout and payment events server-side. Datalyr only sends
    // page views here, including SPA navigations, so purchases are never doubled.
    if (
      pixels?.whop?.enabled &&
      host.whop &&
      (eventName === 'pageview' || eventName === 'page_view')
    ) {
      try {
        host.whop.track('page');
        delivered.add('whop');
      } catch (error) {
        this.log('Error tracking Whop Pixel page:', error);
      }
    }
    if (companionDeliveries.length > 0) await Promise.all(companionDeliveries);
    return ['meta', 'google', 'tiktok', 'whop'].filter((platform) => delivered.has(platform));
  }

  /**
   * TikTok event name for one of our events: the workspace rule map first,
   * then the static default map, then the sanitized raw name.
   */
  private resolveTikTokEventName(tiktokConfig: any, eventName: string, sanitizedEventName: string): string {
    // Map our event names to TikTok's standard vocabulary. BUG FIX (TikTok-dead):
    // this map was keyed on Meta-standard names ('Purchase') but looked up with the
    // sanitized RAW event ('purchase'), so EVERY standard event missed and fired as
    // a literal custom event (e.g. "purchase" instead of "CompletePayment") — all
    // TikTok conversions were mis-categorized. Now keyed on the lowercased raw name
    // and looked up the same way the Meta block does, with a workspace rule map first.
    const tiktokEventMap: Record<string, string> = {
      view_content: 'ViewContent', product_viewed: 'ViewContent', view_item: 'ViewContent',
      search: 'Search',
      add_to_wishlist: 'AddToWishlist',
      add_to_cart: 'AddToCart', product_added: 'AddToCart',
      initiate_checkout: 'InitiateCheckout', begin_checkout: 'InitiateCheckout', checkout_started: 'InitiateCheckout',
      add_payment_info: 'AddPaymentInfo',
      purchase: 'CompletePayment', order_completed: 'CompletePayment', order_paid: 'CompletePayment',
      place_an_order: 'PlaceAnOrder',
      contact: 'Contact',
      download: 'Download',
      lead: 'SubmitForm', submit_form: 'SubmitForm',
      complete_registration: 'CompleteRegistration', sign_up: 'CompleteRegistration', signup: 'CompleteRegistration',
      subscribe: 'Subscribe', subscription_created: 'Subscribe',
    };
    const tiktokRuleMap = tiktokConfig?.event_mappings as Record<string, string> | undefined;
    return tiktokRuleMap?.[eventName]
      || tiktokEventMap[String(eventName).toLowerCase()]
      || sanitizedEventName;
  }

  /**
   * Meta event name for one of our events. Source of truth is the workspace's
   * Meta conversion-rule map, then the static default map, then the sanitized
   * raw name. Shared by the normal and companion paths so both send the name
   * the server-side CAPI sends.
   */
  private resolveMetaEventName(metaConfig: any, eventName: string, sanitizedEventName: string): string {
    // Map our event name to Meta's standard event vocabulary so the browser
    // Pixel fires e.g. "Purchase", not "purchase". This MUST match the
    // platform_standard_event the postback worker sends server-side, or Meta
    // won't dedupe (dedup = event_name + event_id). These defaults mirror the
    // server-side auto-detect map; custom rule choices may not line up.
    const metaEventMap: Record<string, string> = {
      page_view: 'PageView', pageview: 'PageView',
      view_content: 'ViewContent', product_viewed: 'ViewContent', view_item: 'ViewContent',
      add_to_cart: 'AddToCart', product_added: 'AddToCart',
      add_to_wishlist: 'AddToWishlist',
      initiate_checkout: 'InitiateCheckout', begin_checkout: 'InitiateCheckout', checkout_started: 'InitiateCheckout',
      add_payment_info: 'AddPaymentInfo',
      purchase: 'Purchase', order_completed: 'Purchase', order_paid: 'Purchase',
      lead: 'Lead',
      complete_registration: 'CompleteRegistration', sign_up: 'CompleteRegistration', signup: 'CompleteRegistration',
      search: 'Search',
      subscribe: 'Subscribe', subscription_created: 'Subscribe',
      start_trial: 'StartTrial', trial_started: 'StartTrial',
      contact: 'Contact',
      schedule: 'Schedule',
    };
    // Source of truth: the workspace's Meta conversion-rule map (from
    // /container-scripts, keyed by the exact trigger event name) — this is what
    // the server-side CAPI sends, so it guarantees event_name dedup alignment.
    // Fall back to the static default map, then the sanitized raw name.
    const ruleEventMap = metaConfig?.event_mappings as Record<string, string> | undefined;
    return ruleEventMap?.[eventName]
      || metaEventMap[String(eventName).toLowerCase()]
      || sanitizedEventName;
  }

  /**
   * Manually trigger a custom script
   */
  triggerCustomScript(scriptId: string): void {
    if (!this.forwardingAllowed()) return;
    const script = this.scripts.find(s => s.id === scriptId && s.trigger === 'custom');
    if (script && this.shouldLoadScript(script)) {
      this.loadScript(script);
    }
  }

  /**
   * Get loaded scripts
   */
  getLoadedScripts(): string[] {
    return Array.from(this.loadedScripts);
  }

  /**
   * SECURITY MODEL (Phase 1.1 Fix):
   *
   * Inline scripts run in sandboxed iframes with 'allow-scripts' only.
   * This prevents:
   * - Access to parent window/document
   * - Access to cookies and localStorage
   * - Cross-origin requests
   * - Popup creation
   * - Form submission
   *
   * External scripts MUST have SRI (Subresource Integrity) hashes.
   * This prevents:
   * - CDN compromise attacks
   * - Man-in-the-middle script injection
   * - Unauthorized script modifications
   *
   * Previous regex-based validation was removed because it's trivially bypassable.
   * Sandboxing provides defense-in-depth regardless of script content.
   */

  /**
   * Validate script URL
   */
  private isValidScriptUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      
      // Only allow HTTPS in production (allow HTTP for localhost)
      if (parsed.protocol !== 'https:' && !parsed.hostname.includes('localhost')) {
        return false;
      }
      
      // Block data: and javascript: protocols
      if (['data:', 'javascript:', 'file:'].includes(parsed.protocol)) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize event name - whitelist alphanumeric, underscore, dollar sign
   */
  private sanitizeEventName(eventName: string): string {
    if (typeof eventName !== 'string') {
      return 'unknown_event';
    }
    // Allow alphanumeric, underscore, dollar sign, and spaces
    return eventName.replace(/[^a-zA-Z0-9_$ ]/g, '').substring(0, 100);
  }

  /**
   * Recursively sanitize properties object
   */
  private sanitizeProperties(properties: any): any {
    if (properties === null || properties === undefined) {
      return {};
    }

    if (typeof properties !== 'object') {
      return this.sanitizeValue(properties);
    }

    if (Array.isArray(properties)) {
      return properties.map(item => this.sanitizeValue(item));
    }

    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(properties)) {
      // Sanitize key
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 100);
      if (sanitizedKey) {
        sanitized[sanitizedKey] = this.sanitizeValue(value);
      }
    }

    return sanitized;
  }

  /**
   * Sanitize individual value
   */
  private sanitizeValue(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      // Remove potential XSS patterns
      return value
        .replace(/<script[^>]*>.*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .substring(0, 1000);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'object') {
      return this.sanitizeProperties(value);
    }

    return String(value).substring(0, 1000);
  }

  /**
   * Debug logging
   */
  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[Datalyr Container]', ...args);
    }
  }
}
