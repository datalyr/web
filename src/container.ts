/**
 * Container Script Manager
 * Loads and manages third-party tracking scripts and pixels
 */

import { storage } from './storage';
import { sha256Hex } from './utils';
import type { SdkRemoteConfig } from './config';

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
  private sandboxedIframes: HTMLIFrameElement[] = []; // FIXED (ISSUE-02): Track iframes for cleanup
  private iframeCleanupTimeouts = new Map<HTMLIFrameElement, number>(); // FIXED (ISSUE-02): Track cleanup timeouts
  private messageHandler: ((event: MessageEvent) => void) | null = null; // FIXED (ISSUE-02): Track message listener
  // Lazy identity getter so the Pixel can read the SDK's distinct_id / email at
  // the moment of fbq('init'), after the /container-scripts roundtrip has
  // resolved and after any pre-init identify() has updated user state. Reading
  // through a callback avoids snapshotting stale identity at construction.
  private getIdentity?: () => PixelIdentity | undefined;

  constructor(options: {
    workspaceId: string;
    endpoint?: string;
    debug?: boolean;
    getIdentity?: () => PixelIdentity | undefined;
  }) {
    this.workspaceId = options.workspaceId;
    // Container scripts use the same endpoint as tracking (ingest)
    this.endpoint = options.endpoint || 'https://ingest.datalyr.com';
    this.debug = options.debug || false;
    this.getIdentity = options.getIdentity;

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
  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Fetch container configuration
      const response = await fetch(`${this.endpoint}/container-scripts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Container-Version': '1.0'
        },
        body: JSON.stringify({
          workspaceId: this.workspaceId
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch container scripts: ${response.status}`);
      }

      const data = await response.json();
      
      // Store scripts, pixels, and the SDK runtime config envelope.
      this.scripts = data.scripts || [];
      this.pixels = data.pixels || null;
      this.remoteConfig = (data.config && typeof data.config === 'object') ? data.config : undefined;
      
      // Initialize pixels if configured. Awaited so advanced-matching hashes
      // are resolved before the first dl.track() flushes through trackToPixels
      // (otherwise fbq('init') would lag fbq('track') in fast-path tracks).
      if (this.pixels) {
        await this.initializePixels();
      }
      
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

  /**
   * Initialize third-party pixels (Meta, Google, TikTok)
   */
  private async initializePixels(): Promise<void> {
    if (!this.pixels) return;

    // Initialize Meta Pixel
    if (this.pixels.meta?.enabled && this.pixels.meta.pixel_id) {
      await this.initializeMetaPixel(this.pixels.meta);
    }

    // Initialize Google Tag
    if (this.pixels.google?.enabled && this.pixels.google.tag_id) {
      this.initializeGoogleTag(this.pixels.google);
    }

    // Initialize TikTok Pixel
    if (this.pixels.tiktok?.enabled && this.pixels.tiktok.pixel_id) {
      this.initializeTikTokPixel(this.pixels.tiktok);
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

      // Initialize pixel only — do NOT fire PageView here. The SDK's own pageview
      // tracking (track('pageview')) routes through trackToPixels and fires a single
      // mapped PageView with a shared eventID. Firing it again here produced TWO
      // PageViews per load (one un-deduped). Note: if the host app disables pageview
      // tracking entirely, no PageView is sent — which is the correct outcome.
      if (Object.keys(advancedMatching).length > 0) {
        (window as any).fbq('init', config.pixel_id, advancedMatching);
        this.log('Meta Pixel initialized with advanced matching:', config.pixel_id, Object.keys(advancedMatching));
      } else {
        (window as any).fbq('init', config.pixel_id);
        this.log('Meta Pixel initialized (no advanced matching):', config.pixel_id);
      }
    } catch (error) {
      this.log('Error initializing Meta Pixel:', error);
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
   * Track event to all initialized pixels
   */
  trackToPixels(eventName: string, properties: any = {}, eventId?: string): void {
    // Datalyr-internal events ($identify, $group, $alias, $auto_identify,
    // $app_download_click, …) are not conversions — never forward them to ad
    // pixels. (Previously they fired as noise custom events with the $ stripped.)
    if (eventName.startsWith('$')) return;

    // Sanitize inputs to prevent XSS
    const sanitizedEventName = this.sanitizeEventName(eventName);
    const sanitizedProperties = this.sanitizeProperties(properties);

    // Track to Meta Pixel
    if (this.pixels?.meta?.enabled && (window as any).fbq) {
      try {
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
        const ruleEventMap = (this.pixels?.meta as any)?.event_mappings as Record<string, string> | undefined;
        const metaEvent = ruleEventMap?.[eventName]
          || metaEventMap[String(eventName).toLowerCase()]
          || sanitizedEventName;

        // Pass the shared eventID so this Pixel event dedupes against the
        // server-side CAPI event carrying the same event_id.
        if (eventId) {
          (window as any).fbq('track', metaEvent, sanitizedProperties, { eventID: eventId });
        } else {
          (window as any).fbq('track', metaEvent, sanitizedProperties);
        }
      } catch (error) {
        this.log('Error tracking Meta Pixel event:', error);
      }
    }

    // Track to Google Tag
    if (this.pixels?.google?.enabled && (window as any).gtag) {
      try {
        (window as any).gtag('event', sanitizedEventName, sanitizedProperties);
      } catch (error) {
        this.log('Error tracking Google Tag event:', error);
      }
    }

    // Track to TikTok Pixel
    if (this.pixels?.tiktok?.enabled && (window as any).ttq) {
      try {
        // Map common events to TikTok names
        const tiktokEventMap: Record<string, string> = {
          'Purchase': 'CompletePayment',
          'AddToCart': 'AddToCart',
          'InitiateCheckout': 'InitiateCheckout',
          'ViewContent': 'ViewContent',
          'Search': 'Search',
          'Lead': 'SubmitForm'
        };

        const tiktokEvent = tiktokEventMap[sanitizedEventName] || sanitizedEventName;
        (window as any).ttq.track(tiktokEvent, sanitizedProperties);
      } catch (error) {
        this.log('Error tracking TikTok Pixel event:', error);
      }
    }
  }

  /**
   * Manually trigger a custom script
   */
  triggerCustomScript(scriptId: string): void {
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