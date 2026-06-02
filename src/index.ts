/**
 * Datalyr Web SDK
 * Modern attribution tracking for web applications
 */

import { IdentityManager } from './identity';
import { SessionManager } from './session';
import { AttributionManager } from './attribution';
import { EventQueue } from './queue';
import { FingerprintCollector } from './fingerprint';
import { storage, CookieStorage } from './storage';
import { ContainerManager } from './container';
import { dataEncryption } from './encryption'; // SEC-03 Fix
import { AutoIdentifyManager } from './auto-identify';
import { applyRemoteConfig } from './config';
import {
  generateUUID,
  sanitizeEventData,
  deepMerge,
  isDoNotTrackEnabled,
  isGlobalPrivacyControlEnabled,
  getReferrerData
} from './utils';
import type {
  DatalyrConfig,
  EventProperties,
  UserTraits,
  PageProperties,
  SessionData,
  Attribution,
  TouchPoint,
  ConsentConfig,
  IngestEventPayload,
  NetworkStatus,
  ErrorInfo,
  PerformanceMetrics
} from './types';

// Export types
export * from './types';

class Datalyr {
  private config!: DatalyrConfig;
  private identity!: IdentityManager;
  private session!: SessionManager;
  private attribution!: AttributionManager;
  private queue!: EventQueue;
  private fingerprint!: FingerprintCollector;
  private cookies!: CookieStorage;
  private container?: ContainerManager;
  private autoIdentify?: AutoIdentifyManager;
  // Keys the caller passed to init() (before built-in defaults were merged).
  // Lets the remote-config merge override built-in defaults while always
  // deferring to an explicit init() value. See applyRemoteConfig.
  private explicitConfigKeys: ReadonlySet<string> = new Set();
  private superProperties: Record<string, any> = {};
  private userProperties: Record<string, any> = {};
  private optedOut = false;
  private initialized = false;
  private errors: ErrorInfo[] = [];
  private MAX_ERRORS = 50;
  // Store original history methods for cleanup (Issue #15)
  private originalPushState?: typeof history.pushState;
  private originalReplaceState?: typeof history.replaceState;
  private popstateHandler?: EventListener;
  private hashchangeHandler?: EventListener;
  // FIXED (ISSUE-01): Async initialization promise to prevent race conditions
  private initializationPromise: Promise<void> | null = null;

  constructor() {
    // Opt-out check moved to init() after cookies configured (Issue #14)
  }

  /**
   * Initialize the SDK
   */
  init(config: DatalyrConfig): void {
    if (this.initialized) {
      console.warn('[Datalyr] SDK already initialized');
      return;
    }

    // Validate config
    if (!config.workspaceId) {
      throw new Error('[Datalyr] workspaceId is required');
    }

    // Snapshot the keys the caller explicitly set, BEFORE built-in defaults are
    // merged in — so the remote-config merge can override built-in defaults
    // while still deferring to anything the caller passed explicitly.
    this.explicitConfigKeys = new Set(Object.keys(config));

    // Set default config values
    this.config = {
      endpoint: 'https://ingest.datalyr.com',
      debug: false,
      batchSize: 10,
      flushInterval: 5000,
      flushAt: 10,
      criticalEvents: undefined,
      highPriorityEvents: undefined,
      sessionTimeout: 60 * 60 * 1000, // 60 minutes (increased from 30 for OAuth flows)
      trackSessions: true,
      attributionWindow: 90 * 24 * 60 * 60 * 1000, // 90 days (increased from 30 for B2B sales cycles)
      trackedParams: [],
      respectDoNotTrack: false,
      respectGlobalPrivacyControl: true,
      privacyMode: 'standard',
      cookieDomain: 'auto',
      cookieExpires: 365,
      secureCookie: 'auto',
      sameSite: 'Lax',
      cookiePrefix: '__dl_',
      enablePerformanceTracking: true,
      enableFingerprinting: true,
      maxRetries: 5,
      retryDelay: 1000,
      maxOfflineQueueSize: 100,
      trackSPA: true,
      trackPageViews: true,
      fallbackEndpoints: [],
      plugins: [],
      ...config
    };

    // platform:'shopify' implies cart-attribute sync: stamp visitor_id + Meta
    // click signals into note_attributes so server-side order webhooks can
    // attribute guest checkouts. Lets the Shopify theme app-embed enable it via
    // data-platform="shopify" alone. `=== undefined` so an explicit
    // shopifyCartAttributes:false still wins.
    if (this.config.platform === 'shopify' && this.config.shopifyCartAttributes === undefined) {
      this.config.shopifyCartAttributes = true;
    }

    // Initialize cookie storage with config
    this.cookies = new CookieStorage({
      domain: this.config.cookieDomain,
      maxAge: this.config.cookieExpires,
      sameSite: this.config.sameSite,
      secure: this.config.secureCookie
    });

    // Migrate legacy storage keys (fixes double-prefix issue)
    storage.migrateFromLegacyPrefix();

    // Check opt-out AFTER cookies configured (Issue #14)
    this.optedOut = this.cookies.get('__dl_opt_out') === 'true';

    // CC funnel page entry: restore the _dl_* URL bridge BEFORE IdentityManager
    // initializes so the storefront's visitor_id is the one used here (instead
    // of auto-generating a fresh one on this domain).
    if (this.config.platform === 'checkoutchamp') {
      this.restoreFromURL();
    }

    // Initialize modules
    this.identity = new IdentityManager();
    this.session = new SessionManager(this.config.sessionTimeout);
    this.attribution = new AttributionManager({
      attributionWindow: this.config.attributionWindow,
      trackedParams: this.config.trackedParams
    });
    this.queue = new EventQueue(this.config);
    this.fingerprint = new FingerprintCollector({
      privacyMode: this.config.privacyMode,
      enableFingerprinting: this.config.enableFingerprinting
    });

    // Set session ID in identity manager
    const sessionId = this.session.getSessionId();
    this.identity.setSessionId(sessionId);

    // FIXED (ISSUE-01): Start async initialization immediately but don't block constructor
    // This allows encryption to initialize before any events are tracked
    this.initializeAsync();

    // Setup page unload handler
    this.setupUnloadHandler();

    // Initialize plugins
    if (this.config.plugins) {
      for (const plugin of this.config.plugins) {
        try {
          plugin.initialize(this);
          this.log(`Plugin initialized: ${plugin.name}`);
        } catch (error) {
          // Issue #16: Always warn about plugin failures, even when debug is false
          console.warn(`[Datalyr] Plugin '${plugin.name}' failed to initialize:`, error);
          this.trackError(error as Error, { plugin: plugin.name });
        }
      }
    }

    this.initialized = true;
    this.log('SDK initialized');
  }

  /**
   * Complete async initialization (encryption, user properties, container, page view)
   *
   * FIXED (ISSUE-01): Separated async initialization to prevent race conditions
   * Encryption must complete before first events are tracked
   */
  private async initializeAsync(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        // SEC-03 Fix: Initialize encryption for PII data
        const deviceId = this.identity.getAnonymousId();
        await dataEncryption.initialize(this.config.workspaceId, deviceId);

        // Load encrypted user properties
        this.userProperties = await storage.getEncrypted('dl_user_traits', {});
        this.log('Encryption initialized, user properties loaded');

        // Setup SPA tracking if enabled
        if (this.config.trackSPA) {
          this.setupSPATracking();
        }

        // Initialize container manager if enabled.
        // WEB-4 (privacy gate): the container loads third-party pixels (Meta/Google/
        // TikTok) and calls fbq('init', …, advancedMatching) with the visitor's
        // SHA-256 email/id — so it must NOT initialize for opted-out / DNT / GPC
        // visitors, nor when privacyMode is explicitly 'strict'. (Remote config can't
        // gate this: the container fetch is what delivers the remote config, so only
        // local consent signals + an explicit strict init() are knowable here.)
        const privacyStrict = this.config.privacyMode === 'strict';
        if (this.config.enableContainer !== false && this.shouldTrack() && !privacyStrict) {
          this.container = new ContainerManager({
            workspaceId: this.config.workspaceId,
            endpoint: this.config.endpoint,
            debug: this.config.debug,
            // Lazy: invoked at the moment a third-party pixel inits, AFTER the
            // /container-scripts roundtrip resolves — so a pre-init identify()
            // already updated this.identity / this.userProperties. distinctId
            // mirrors what CAPI puts in external_id[] (user_id || anonymous_id);
            // email lets the Pixel match on em with the same hash CAPI sends.
            getIdentity: () => ({
              externalId: this.identity?.getDistinctId(),
              email: this.userProperties?.email,
            })
          });

          // Initialize container asynchronously
          await this.container.init().catch(error => {
            this.log('Container initialization failed:', error);
          });

          // Checkout Champ thank-you/upsell page: co-fire the browser Meta Pixel
          // Purchase with the SAME deterministic event_id the CC webhook stamps
          // server-side, so Meta dedupes the browser event against the server-side
          // CAPI event (dedup = event_name + event_id). Pixel-only — the CC Export
          // Profile webhook owns the server event + CAPI postback. No-op anywhere
          // except a post-purchase page (keyed on CC's sessionStorage orderData).
          // Must run AFTER container.init() so fbq is loaded + init'd.
          if (this.config.platform === 'checkoutchamp') {
            this.fireCheckoutChampPurchasePixel();
          }
        }

        // Fold the remote /container-scripts config UNDER explicit init()
        // overrides (precedence: defaults <- remote <- explicit). No-op if the
        // container is disabled or the worker didn't send `config`. This is what
        // makes the dashboard toggles take effect with no snippet edits.
        applyRemoteConfig(this.config, this.container?.getRemoteConfig(), this.explicitConfigKeys);

        // Privacy-strict turns auto-identify (email capture) OFF regardless of
        // the dashboard/remote value — privacy wins over the bridge.
        if (this.config.privacyMode === 'strict') {
          this.config.autoIdentify = false;
        }

        // autoIdentify default for the CC bridge:
        // - platform === 'checkoutchamp' (CC funnel pages) OR
        // - checkoutChampDomains set (Shopify storefronts feeding a CC funnel)
        // turn autoIdentify on unless the caller explicitly set it to false.
        // The 95% claim relies on email capture on BOTH ends of the bridge.
        const ccBridgeActive = this.config.platform === 'checkoutchamp'
          || (Array.isArray(this.config.checkoutChampDomains) && this.config.checkoutChampDomains.length > 0);
        if (ccBridgeActive && this.config.autoIdentify === undefined) {
          this.config.autoIdentify = true;
        }

        // Initialize auto-identify when enabled (explicit or remote) AND
        // tracking is allowed. The shouldTrack() gate keeps capture from even
        // setting up its form/API interceptors for opted-out / DNT / GPC users.
        if (this.config.autoIdentify === true && this.shouldTrack()) {
          this.autoIdentify = new AutoIdentifyManager({
            enabled: true,
            captureFromForms: this.config.autoIdentifyForms,
            captureFromAPI: this.config.autoIdentifyAPI,
            captureFromShopify: this.config.autoIdentifyShopify,
            trustedDomains: this.config.autoIdentifyTrustedDomains,
            debug: this.config.debug
          });

          // Setup auto-identify callback
          this.autoIdentify.initialize((email: string, source: string) => {
            this.log(`Auto-identified user: ${email} from ${source}`);

            // Track auto-identify event
            this.track('$auto_identify', {
              email,
              source,
              timestamp: Date.now()
            });

            // Automatically call identify with email
            this.identify(email, { email });
          });
        }

        // Stamp attribution signals into the Shopify cart (OPT-IN, default off).
        // Lets server-side order webhooks recover the browser visitor + Meta click
        // signals (the postback webhook reads these as note_attributes). Inert unless
        // enabled; best-effort and never blocks init.
        if (this.config.shopifyCartAttributes === true && this.shouldTrack()) {
          this.syncShopifyCartAttributes().catch((error) => {
            this.log('Shopify cart attribute sync failed:', error);
          });
        }

        // Storefront → CC bridge: stamp _dl_* params on outbound links to the
        // configured CC domains so visitor_id + click signals cross the domain
        // boundary. Inert unless checkoutChampDomains is set.
        if (Array.isArray(this.config.checkoutChampDomains) && this.config.checkoutChampDomains.length > 0) {
          this.syncOutboundLinkParams(this.config.checkoutChampDomains);
        }

        // Track initial page view if enabled (AFTER encryption ready)
        if (this.config.trackPageViews) {
          this.page();
        }

        this.log('Async initialization complete');
      } catch (error) {
        console.error('[Datalyr] Async initialization failed:', error);
        // Fallback: Load unencrypted and continue
        this.userProperties = storage.get('dl_user_traits', {});
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Wait for async initialization to complete
   * FIXED (ISSUE-01): Public method to await full initialization
   */
  async ready(): Promise<void> {
    if (!this.initialized) {
      throw new Error('[Datalyr] SDK not initialized. Call init() first.');
    }
    return this.initializationPromise || Promise.resolve();
  }

  /**
   * Track an event
   */
  track(eventName: string, properties: EventProperties = {}): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    if (!this.shouldTrack()) return;

    try {
      // PRIVACY: Heavy fingerprinting removed - using minimal fingerprinting only

      // Update session activity
      this.session.updateActivity(eventName);

      // Generate the event_id ONCE here so the same value is used for both the
      // ingested event (→ CAPI dedup key in the postback worker) and the browser
      // Meta Pixel co-fire below. Sharing it is what lets Meta dedupe the Pixel
      // event against the server-side CAPI event (dedup = event_id + event_name).
      const eventId = generateUUID();

      // Create event payload
      const payload = this.createEventPayload(eventName, properties, eventId);

      // Queue event
      this.queue.enqueue(payload);

      // Track to third-party pixels if container is initialized.
      // Pass the shared eventId so the Meta Pixel fires with the same { eventID }.
      if (this.container) {
        this.container.trackToPixels(eventName, properties, eventId);
      }

      // Call plugin handlers
      if (this.config.plugins) {
        for (const plugin of this.config.plugins) {
          if (plugin.track) {
            try {
              plugin.track(eventName, properties);
            } catch (error) {
              this.trackError(error as Error, { plugin: plugin.name, event: eventName });
            }
          }
        }
      }

      this.log('Event tracked:', eventName);
    } catch (error) {
      this.trackError(error as Error, { event: eventName });
    }
  }

  /**
   * Track an app download click and redirect to the app store.
   * Fires a $app_download_click event with full attribution data,
   * then redirects the user to the appropriate store URL.
   * For Android, encodes attribution params into the Play Store referrer
   * so the mobile SDK can retrieve them deterministically after install.
   */
  trackAppDownloadClick(options: {
    targetPlatform: 'ios' | 'android';
    appStoreUrl: string;
  }): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    if (!this.shouldTrack()) return;

    // Fire the event with target platform info — attribution data is
    // automatically merged by createEventPayload via getAttributionData()
    this.track('$app_download_click', {
      target_platform: options.targetPlatform,
      app_store_url: options.appStoreUrl,
    });

    // Flush immediately via sendBeacon before page navigates away
    this.queue.forceFlush();

    // For Android: append referrer param to Play Store URL with click attribution
    if (options.targetPlatform === 'android' && options.appStoreUrl.includes('play.google.com')) {
      const lastTouch = this.attribution.getLastTouch();
      const referrerParams = new URLSearchParams();
      if (lastTouch?.clickId) referrerParams.set('dl_click_id', lastTouch.clickId);
      if (lastTouch?.clickIdType) referrerParams.set('dl_click_id_type', lastTouch.clickIdType);
      if (lastTouch?.source) referrerParams.set('utm_source', lastTouch.source);
      if (lastTouch?.medium) referrerParams.set('utm_medium', lastTouch.medium);
      if (lastTouch?.campaign) referrerParams.set('utm_campaign', lastTouch.campaign);
      if (lastTouch?.content) referrerParams.set('utm_content', lastTouch.content);
      if (lastTouch?.term) referrerParams.set('utm_term', lastTouch.term);

      try {
        const url = new URL(options.appStoreUrl);
        url.searchParams.set('referrer', referrerParams.toString());
        window.location.href = url.toString();
      } catch {
        // If URL parsing fails, redirect without referrer
        window.location.href = options.appStoreUrl;
      }
    } else {
      window.location.href = options.appStoreUrl;
    }
  }

  /**
   * Identify a user
   */
  identify(userId: string, traits: UserTraits = {}): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    if (!this.shouldTrack()) return;
    if (!userId) {
      console.warn('[Datalyr] identify() called without userId');
      return;
    }

    try {
      // FIXED (DATA-05): Rotate session ID on identify to prevent session fixation
      if (this.session) {
        this.session.rotateSessionId();
      }

      // Update identity
      const identityLink = this.identity.identify(userId, traits);

      // SEC-03 Fix: Store user properties encrypted (contains PII)
      // FIXED (H2): Fail loudly instead of silent fallback to unencrypted
      this.userProperties = { ...this.userProperties, ...traits };
      storage.setEncrypted('dl_user_traits', this.userProperties).catch(error => {
        console.error('[Datalyr] Failed to encrypt user traits - NOT storing unencrypted PII:', error);
        console.error('[Datalyr] User traits will only persist in memory until page reload');
        // DO NOT fallback to unencrypted storage - this would expose PII
        // This is a breaking change from the previous silent fallback behavior
        // If encryption fails, user traits are only stored in memory (this.userProperties)
        // and will be lost on page reload - but PII is NOT exposed in localStorage
      });

      // Track $identify event
      this.track('$identify', {
        ...identityLink,
        traits
      });

      // Call plugin handlers
      if (this.config.plugins) {
        for (const plugin of this.config.plugins) {
          if (plugin.identify) {
            try {
              plugin.identify(userId, traits);
            } catch (error) {
              this.trackError(error as Error, { plugin: plugin.name });
            }
          }
        }
      }

      this.log('User identified:', userId);
    } catch (error) {
      this.trackError(error as Error, { userId });
    }
  }

  /**
   * Track a page view
   */
  page(properties: PageProperties = {}): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    if (!this.shouldTrack()) return;

    const pageData: PageProperties = {
      title: document.title,
      url: window.location.href,
      path: window.location.pathname,
      search: window.location.search,
      referrer: document.referrer,
      ...properties
    };

    // Add referrer data
    const referrerData = getReferrerData();
    Object.assign(pageData, referrerData);

    // Add performance metrics if enabled
    if (this.config.enablePerformanceTracking) {
      const metrics = this.getPerformanceMetrics();
      if (metrics) {
        pageData.performance = metrics;
      }
    }

    this.track('pageview', pageData);

    // Call plugin handlers
    if (this.config.plugins) {
      for (const plugin of this.config.plugins) {
        if (plugin.page) {
          try {
            plugin.page(pageData);
          } catch (error) {
            this.trackError(error as Error, { plugin: plugin.name });
          }
        }
      }
    }
  }

  /**
   * Track a screen view (for SPAs).
   * Fires a `pageview` event with a `screen` property, consistent with
   * the React Native and iOS SDKs.
   */
  screen(screenName: string, properties: Record<string, any> = {}): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    if (!this.shouldTrack()) return;

    this.track('pageview', {
      screen: screenName,
      ...properties
    });
  }

  /**
   * Associate user with a group/account
   */
  group(groupId: string, traits: Record<string, any> = {}): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    this.track('$group', {
      group_id: groupId,
      traits
    });
  }

  /**
   * Alias one ID to another
   */
  alias(userId: string, previousId?: string): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    const aliasData = this.identity.alias(userId, previousId);
    this.track('$alias', aliasData);
  }

  /**
   * Reset the current user
   */
  reset(): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    this.identity.reset();
    this.userProperties = {};
    storage.remove('dl_user_traits');
    this.session.createNewSession();
    this.log('User reset');
  }

  /**
   * Get the current anonymous ID
   */
  getAnonymousId(): string {
    return this.identity.getAnonymousId();
  }

  /**
   * Get the current visitor ID (alias for getAnonymousId).
   * Matches the `visitor_id` terminology used in the dashboard, schema,
   * and integration guides — pass this to Stripe's `client_reference_id`
   * or webhook metadata for first-party attribution.
   */
  getVisitorId(): string {
    return this.identity.getAnonymousId();
  }

  /**
   * Returns a metadata bundle ready to pass to Stripe so the webhook can
   * deterministically link the payment back to this browser session (90%+
   * attribution match vs. 70-85% email-only).
   *
   * Usage (Stripe Checkout Session):
   *   stripe.checkout.sessions.create({
   *     ...datalyr.getStripeMetadata(),
   *     line_items: [...],
   *   })
   *
   * Usage (PaymentIntent / Subscription / Customer):
   *   stripe.paymentIntents.create({
   *     amount, currency,
   *     metadata: datalyr.getStripeMetadata().metadata,
   *   })
   *
   * The server-side Datalyr webhook reads `client_reference_id` on Checkout
   * and `metadata.visitor_id` on every other Stripe object.
   */
  getStripeMetadata(): { client_reference_id: string; metadata: { visitor_id: string } } {
    const visitorId = this.identity.getAnonymousId();
    return {
      client_reference_id: visitorId,
      metadata: { visitor_id: visitorId },
    };
  }

  /**
   * Returns a metadata object ready to attach to a Whop checkout configuration.
   * Whop inherits checkout-configuration metadata onto payments and memberships
   * (https://docs.whop.com/api-reference/checkout-configurations/), so Datalyr
   * can read `metadata.visitor_id` off every resulting webhook event.
   *
   * Usage:
   *   whop.checkoutConfigurations.create({
   *     plan_id,
   *     metadata: datalyr.getWhopCheckoutMetadata(),
   *   })
   */
  getWhopCheckoutMetadata(): { visitor_id: string } {
    return { visitor_id: this.identity.getAnonymousId() };
  }

  /**
   * Get the current user ID
   */
  getUserId(): string | null {
    return this.identity.getUserId();
  }

  /**
   * Get the distinct ID
   */
  getDistinctId(): string {
    return this.identity.getDistinctId();
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.session.getSessionId();
  }

  /**
   * Start a new session manually
   */
  startNewSession(): string {
    const sessionId = this.session.createNewSession();
    this.identity.setSessionId(sessionId);
    return sessionId;
  }

  /**
   * Get session data
   */
  getSessionData(): SessionData | null {
    return this.session.getSessionData();
  }

  /**
   * Get current attribution data
   */
  getAttribution(): Attribution {
    return this.attribution.captureAttribution();
  }

  /**
   * Get customer journey
   */
  getJourney(): TouchPoint[] {
    return this.attribution.getJourney();
  }

  /**
   * Set attribution manually
   */
  setAttribution(attribution: Partial<Attribution>): void {
    const current = this.attribution.captureAttribution();
    const merged = { ...current, ...attribution };
    this.session.storeAttribution(merged);
  }

  /**
   * Opt out of tracking
   */
  optOut(): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    this.optedOut = true;
    this.cookies.set('__dl_opt_out', 'true', this.config.cookieExpires);
    this.queue.clear();
    this.log('User opted out');
  }

  /**
   * Opt in to tracking
   */
  optIn(): void {
    if (!this.initialized) {
      console.warn('[Datalyr] SDK not initialized. Call init() first.');
      return;
    }
    this.optedOut = false;
    this.cookies.set('__dl_opt_out', 'false', this.config.cookieExpires);
    this.log('User opted in');
  }

  /**
   * Check if user has opted out
   */
  isOptedOut(): boolean {
    return this.optedOut;
  }

  /**
   * Set consent preferences
   */
  setConsent(consent: ConsentConfig): void {
    storage.set('dl_consent', consent);
    this.log('Consent updated:', consent);
  }

  /**
   * Manually flush the event queue
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  /**
   * Set super properties
   */
  setSuperProperties(properties: Record<string, any>): void {
    this.superProperties = { ...this.superProperties, ...properties };
    this.log('Super properties set:', properties);
  }

  /**
   * Unset a super property
   */
  unsetSuperProperty(propertyName: string): void {
    delete this.superProperties[propertyName];
    this.log('Super property unset:', propertyName);
  }

  /**
   * Get super properties
   */
  getSuperProperties(): Record<string, any> {
    return { ...this.superProperties };
  }

  /**
   * Stamp Datalyr attribution signals into the Shopify cart as cart attributes.
   * Cart attributes become `order.note_attributes` with the same names, which the
   * server-side order webhook reads to recover the browser visitor_id + Meta click
   * signals (_fbc/_fbp/fbclid) — enabling accurate Meta CAPI attribution for orders.
   *
   * Opt-in (config.shopifyCartAttributes), best-effort, runs once during init.
   * Merges via Shopify's /cart/update.js (does not clobber other cart attributes).
   */
  private async syncShopifyCartAttributes(): Promise<void> {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const isShopify = !!(
      (window as any).Shopify ||
      document.querySelector('meta[name="shopify-checkout-api-token"]') ||
      window.location.hostname.includes(".myshopify.com")
    );
    if (!isShopify) return;

    const attribution = this.attribution.getAttributionData();
    const fbclid =
      attribution.clickIdType === "fbclid" ? attribution.clickId : null;

    // Cookies are freshest (the real Meta Pixel may have just written them);
    // fall back to whatever the SDK captured in attribution.
    const attributes: Record<string, string> = {};
    const visitorId = this.identity.getAnonymousId();
    const fbc = this.cookies.get("_fbc") || (attribution as any)._fbc;
    const fbp = this.cookies.get("_fbp") || (attribution as any)._fbp;
    const fbclidAt = this.cookies.get("_dl_fbclid_at");
    if (visitorId) attributes._datalyr_visitor_id = visitorId;
    if (fbc) attributes._datalyr_fbc = String(fbc);
    if (fbp) attributes._datalyr_fbp = String(fbp);
    if (fbclid) attributes._datalyr_fbclid = String(fbclid);
    if (fbclidAt) attributes._datalyr_fbclid_at = String(fbclidAt);

    if (Object.keys(attributes).length === 0) return;

    try {
      await fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ attributes }),
      });
      this.log("Shopify cart attributes stamped:", Object.keys(attributes));
    } catch (error) {
      // Never let cart sync affect tracking — swallow (e.g. no cart yet / CSP).
      this.log("Shopify /cart/update.js failed:", error);
    }
  }

  /**
   * Restore _dl_* URL bridge params on a Checkout Champ funnel page.
   * Runs BEFORE IdentityManager so the storefront's visitor_id wins over a
   * freshly auto-generated one. Also restores _fbc / _fbp cookies and the
   * fbclid click time so server-side rebuilds carry the real click moment.
   *
   * Strategy: stamp matching cookies (without clobbering pre-existing values),
   * then rewrite the URL so `_dl_fbclid` becomes `fbclid` — that way the rest
   * of the SDK's attribution layer (which reads `params.fbclid`) works
   * unchanged, and any merchant analytics also see the canonical click ID.
   */
  private restoreFromURL(): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      const get = (k: string) => params.get(k);

      const vid = get("_dl_vid");
      const fbc = get("_dl_fbc");
      const fbp = get("_dl_fbp");
      const fbclid = get("_dl_fbclid");
      const fbclidAt = get("_dl_fbclid_at");
      const gclid = get("_dl_gclid");
      const gclidAt = get("_dl_gclid_at");

      // visitor_id: bridge wins. The whole point of `_dl_vid` is to unify the
      // storefront's session with the CC funnel session. A pre-existing local
      // cookie from a prior direct CC visit would silently sink the integration
      // (CC events stay on the local id; storefront events use the bridged id;
      // the two never link). Overwrite — orphaned local events are fine.
      if (vid) this.cookies.set("__dl_visitor_id", vid, 365);

      // Meta cookies + click-time cookies: existing wins. _fbc / _fbp may have
      // been written by Meta Pixel on the CC funnel page itself (more recent
      // than the bridged value); _dl_fbclid_at should record first-touch click
      // time per device, not get reset by a bridge from a new campaign.
      const setIfMissing = (name: string, value: string | null) => {
        if (!value) return;
        if (this.cookies.get(name)) return;
        this.cookies.set(name, value, 365);
      };
      setIfMissing("_fbc", fbc);
      setIfMissing("_fbp", fbp);
      setIfMissing("_dl_fbclid_at", fbclidAt);
      setIfMissing("_dl_gclid_at", gclidAt);

      // Rewrite URL: _dl_fbclid → fbclid (etc.) so captureAttribution() picks
      // them up via its existing `params.fbclid` path. Strip the _dl_* params
      // either way so they don't leak into downstream analytics URLs.
      let rewrote = false;
      const mappings: Array<[string, string | null]> = [
        ["fbclid", fbclid],
        ["gclid", gclid]
      ];
      for (const [canonical, value] of mappings) {
        if (value && !params.get(canonical)) {
          params.set(canonical, value);
          rewrote = true;
        }
      }
      for (const k of ["_dl_vid", "_dl_fbc", "_dl_fbp", "_dl_fbclid", "_dl_fbclid_at", "_dl_gclid", "_dl_gclid_at"]) {
        if (params.has(k)) {
          params.delete(k);
          rewrote = true;
        }
      }
      if (rewrote && typeof window.history?.replaceState === "function") {
        const newSearch = params.toString();
        const newUrl =
          window.location.pathname +
          (newSearch ? "?" + newSearch : "") +
          window.location.hash;
        window.history.replaceState(window.history.state, "", newUrl);
      }

      this.log("Checkout Champ bridge restored:", {
        had_vid: !!vid,
        had_fbc: !!fbc,
        had_fbp: !!fbp,
        had_fbclid: !!fbclid,
        had_gclid: !!gclid
      });
    } catch (error) {
      // Don't let bridge restoration block init — fall through to normal SDK
      // behavior (a fresh visitor_id, no restored click signals).
      this.log("restoreFromURL failed:", error);
    }
  }

  /**
   * Checkout Champ Meta Pixel ⇄ CAPI deduplication.
   *
   * On a CC thank-you / upsell page, fire the BROWSER Meta Pixel Purchase with the
   * exact same event_id the CC webhook stamps server-side, so Meta collapses the
   * browser Pixel event and the server-side CAPI event into one (dedup key =
   * event_name + event_id). This gives the EMQ lift of a matched browser+server
   * event without double-counting conversions in Ads Manager.
   *
   * PIXEL-ONLY by design. We do NOT enqueue a server event here: the CC Export
   * Profile webhook (webhooks/platforms/checkoutchamp.js) already ingests the
   * purchase and fires CAPI. Calling track() here would create a second server
   * event (source='web') AND double-fire CAPI — defeating the whole point.
   *
   * The event_id MUST stay byte-identical to the server formula:
   *   webhooks/platforms/checkoutchamp.js:250
   *     generateEventId('checkoutchamp', `${event_type}_${order_id}`)
   *   webhooks/core/ingest.js:122  →  `${platform}_${webhookEventId}`
   *   ⇒ `checkoutchamp_purchase_<order_id>`
   * where <order_id> is the value CC posts to the webhook via its [orderId] macro.
   * We read the browser-side counterpart from CC's own client-side order object:
   *   JSON.parse(sessionStorage.getItem('orderData')).orderId
   * (CC docs: referenced in custom scripts as `orderDataTmp.orderId`).
   *
   * ASSUMPTION TO VERIFY ON A REAL CC TEST ORDER: that sessionStorage
   * orderData.orderId === the [orderId] CC sends to the postback. If a merchant's
   * CC plan exposes a different id client-side, the two event_ids won't match and
   * Meta will show duplicates — caught by the test order in the setup checklist.
   *
   * v1 scope: the primary order only. Per-upsell Pixel dedup (each upsell is its
   * own order_id + parent_order_id server-side) needs the upsell sessionStorage
   * shape confirmed on a live funnel first — tracked as a follow-up.
   */
  private fireCheckoutChampPurchasePixel(): void {
    if (typeof window === "undefined") return;
    try {
      // Needs the container (where the Meta Pixel lives). trackToPixels itself
      // no-ops unless a Meta pixel is enabled + fbq is present, so an
      // unconfigured workspace silently does nothing.
      if (!this.container) return;

      const raw = window.sessionStorage?.getItem("orderData");
      if (!raw) return; // not a post-purchase page — nothing to dedupe

      const order = JSON.parse(raw) || {};
      const orderId = order.orderId;
      if (!orderId) return;

      // orderData persists across upsell page loads — fire the primary Purchase
      // Pixel once per order. (Meta also dedupes by event_id over 48h, so this is
      // belt-and-suspenders against a per-page re-fire.)
      const guardKey = `__dl_cc_purchase_${orderId}`;
      if (window.sessionStorage.getItem(guardKey)) return;
      window.sessionStorage.setItem(guardKey, "1");

      // KEEP IN SYNC with the server formula above.
      const eventId = `checkoutchamp_purchase_${orderId}`;

      // value/currency are for EMQ quality only — Meta dedup is event_id+name, so
      // a mismatch here never breaks dedup. Best-effort parse of CC's fields.
      const value = Number(order.totalAmount);
      const properties: Record<string, any> = {
        order_id: String(orderId),
        content_type: "product",
      };
      if (Number.isFinite(value)) properties.value = value;
      const currency = order.currencyCode || order.currency;
      if (currency) properties.currency = String(currency);
      if (order.productId) properties.content_ids = [String(order.productId)];

      // Pixel-only co-fire. 'purchase' maps to Meta 'Purchase' in trackToPixels,
      // matching the server-side rule's platform_event_name.
      this.container.trackToPixels("purchase", properties, eventId);

      this.log("Checkout Champ Purchase Pixel co-fired (CAPI dedup):", {
        eventId,
        value: properties.value,
        currency: properties.currency,
      });
    } catch (error) {
      // Never let dedup co-fire break the page or init.
      this.log("fireCheckoutChampPurchasePixel failed:", error);
    }
  }

  /**
   * Storefront → Checkout Champ link stamping. Finds every `<a href>` whose host
   * matches the configured CC domain list and appends `?_dl_vid=…&_dl_fbc=…&
   * _dl_fbp=…&_dl_fbclid=…&_dl_fbclid_at=…&_dl_gclid=…` so the user's
   * visitor_id + Meta click signals cross the domain. MutationObserver watches
   * for dynamically-injected links. On click, force-flush the event queue so
   * any pending track() events land before the browser navigates away.
   */
  private syncOutboundLinkParams(domains: string[]): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const lowerDomains = domains.map((d) => d.toLowerCase());
    const matchesCcDomain = (href: string): boolean => {
      try {
        const host = new URL(href, window.location.href).hostname.toLowerCase();
        return lowerDomains.some((d) => host === d || host.endsWith("." + d));
      } catch {
        return false;
      }
    };

    const buildBridgeParams = (): Record<string, string> => {
      const attribution = this.attribution.getAttributionData();
      const out: Record<string, string> = {};
      const vid = this.identity.getAnonymousId();
      const fbc = this.cookies.get("_fbc") || (attribution as any)._fbc;
      const fbp = this.cookies.get("_fbp") || (attribution as any)._fbp;
      const fbclid = attribution.clickIdType === "fbclid" ? attribution.clickId : null;
      const fbclidAt = this.cookies.get("_dl_fbclid_at");
      const gclid = attribution.clickIdType === "gclid" ? attribution.clickId : null;
      const gclidAt = this.cookies.get("_dl_gclid_at");
      if (vid) out._dl_vid = vid;
      if (fbc) out._dl_fbc = String(fbc);
      if (fbp) out._dl_fbp = String(fbp);
      if (fbclid) out._dl_fbclid = String(fbclid);
      if (fbclidAt) out._dl_fbclid_at = String(fbclidAt);
      if (gclid) out._dl_gclid = String(gclid);
      if (gclidAt) out._dl_gclid_at = String(gclidAt);
      return out;
    };

    const stampLink = (anchor: HTMLAnchorElement) => {
      if (!anchor.href || !matchesCcDomain(anchor.href)) return;
      try {
        const u = new URL(anchor.href, window.location.href);
        const bridge = buildBridgeParams();
        let mutated = false;
        for (const [k, v] of Object.entries(bridge)) {
          if (!u.searchParams.get(k)) {
            u.searchParams.set(k, v);
            mutated = true;
          }
        }
        if (mutated) anchor.href = u.toString();
      } catch {
        // Ignore malformed URLs — don't break the page.
      }
    };

    const stampAll = () => {
      document.querySelectorAll("a[href]").forEach((el) => stampLink(el as HTMLAnchorElement));
    };

    const onClick = (e: Event) => {
      const target = (e.target as Element | null)?.closest("a[href]");
      if (!target) return;
      const anchor = target as HTMLAnchorElement;
      if (!matchesCcDomain(anchor.href)) return;
      stampLink(anchor); // re-stamp in case attribution changed since DOMReady
      try {
        this.queue?.flush();
      } catch {
        // Best-effort — never block navigation.
      }
    };

    stampAll();
    document.addEventListener("click", onClick, true);

    try {
      // Debounce re-stamping. A busy SPA (infinite scroll, animations,
      // React/Vue updates) can fire thousands of mutations per second; a naive
      // re-stamp on every notification would burn CPU pointlessly when
      // outbound link sets only change occasionally. 150ms is small enough to
      // catch links before the user can click them, large enough to coalesce
      // bursts.
      let restampTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRestamp = () => {
        if (restampTimer != null) return;
        restampTimer = setTimeout(() => {
          restampTimer = null;
          stampAll();
        }, 150);
      };
      const observer = new MutationObserver(scheduleRestamp);
      observer.observe(document.documentElement, { childList: true, subtree: true });

      // Observer + click listener live for the session; pagehide cleans up on
      // full-page unload. SPA route changes are fine — we WANT stamping to keep
      // working across virtual navigations.
      window.addEventListener("pagehide", () => {
        try { observer.disconnect(); } catch { /* idempotent */ }
        if (restampTimer != null) clearTimeout(restampTimer);
        document.removeEventListener("click", onClick, true);
      }, { once: true });
    } catch (error) {
      this.log("MutationObserver setup failed (CC link sync):", error);
    }

    this.log("Checkout Champ outbound-link sync active for:", lowerDomains);
  }

  /**
   * Create event payload
   */
  private createEventPayload(eventName: string, properties: Record<string, any>, eventIdArg?: string): IngestEventPayload {
    // Sanitize and merge properties
    const sanitizedProperties = sanitizeEventData(properties);
    const eventData = deepMerge(
      {},
      this.superProperties,
      sanitizedProperties
    );

    // Add attribution data
    const attributionData = this.attribution.getAttributionData();
    Object.assign(eventData, attributionData);

    // Add session metrics
    const sessionMetrics = this.session.getMetrics();
    Object.assign(eventData, sessionMetrics);

    // Add fingerprint data if enabled
    if (this.config.enableFingerprinting) {
      const fingerprintData = this.fingerprint.collect();
      Object.assign(eventData, {
        device_fingerprint: fingerprintData // Use snake_case only (matches backend)
      });
    }

    // Add browser context
    Object.assign(eventData, {
      url: window.location.href,
      path: window.location.pathname,
      referrer: document.referrer,
      title: document.title,
      screen_width: screen.width,
      screen_height: screen.height,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight
    });

    // Create payload using snake_case only (matches backend API and production script)
    const identityFields = this.identity.getIdentityFields();
    // Use the caller-provided event_id (shared with the Meta Pixel co-fire for
    // dedup); fall back to a fresh UUID for any direct caller that omits it.
    const eventId = eventIdArg ?? generateUUID();

    // Ensure we have all required identity fields
    const distinctId = identityFields.distinct_id;
    const anonymousId = identityFields.anonymous_id;
    const visitorId = identityFields.visitor_id || anonymousId;
    const sessionId = identityFields.session_id;

    const payload: IngestEventPayload = {
      // Required fields (snake_case only - no duplication)
      workspace_id: this.config.workspaceId,
      event_id: eventId,
      event_name: eventName,
      event_data: eventData,
      source: 'web',
      timestamp: new Date().toISOString(),

      // Identity fields (snake_case only)
      distinct_id: distinctId,
      anonymous_id: anonymousId,
      visitor_id: visitorId,
      user_id: identityFields.user_id,
      canonical_id: identityFields.canonical_id,
      session_id: sessionId,

      // Resolution metadata
      resolution_method: 'browser_sdk',
      resolution_confidence: 1.0,

      // SDK metadata (keep in sync with package.json version)
      sdk_version: '1.6.5',
      sdk_name: 'datalyr-web-sdk'
    };

    return payload;
  }

  /**
   * Check if we should track
   */
  private shouldTrack(): boolean {
    // Check opt-out
    if (this.optedOut) {
      return false;
    }

    // Check Do Not Track
    if (this.config.respectDoNotTrack && isDoNotTrackEnabled()) {
      return false;
    }

    // Check Global Privacy Control
    if (this.config.respectGlobalPrivacyControl && isGlobalPrivacyControlEnabled()) {
      return false;
    }

    return true;
  }

  /**
   * Setup SPA tracking
   * Fixed Issue #15: Store original methods for cleanup
   * Fixed CRITICAL-03: Clear attribution cache on navigation to prevent stale data
   */
  private setupSPATracking(): void {
    // Store original methods for cleanup
    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;
    const self = this;

    // Override pushState
    history.pushState = function(...args) {
      self.originalPushState!.apply(history, args);
      setTimeout(() => {
        // Clear attribution cache to capture fresh URL params
        self.attribution.clearCache();
        self.page();
      }, 0);
    };

    // Override replaceState
    history.replaceState = function(...args) {
      self.originalReplaceState!.apply(history, args);
      setTimeout(() => {
        // Clear attribution cache to capture fresh URL params
        self.attribution.clearCache();
        self.page();
      }, 0);
    };

    // Listen for popstate
    this.popstateHandler = () => {
      setTimeout(() => {
        // Clear attribution cache to capture fresh URL params
        self.attribution.clearCache();
        self.page();
      }, 0);
    };
    window.addEventListener('popstate', this.popstateHandler);

    // Listen for hashchange
    this.hashchangeHandler = () => {
      // Clear attribution cache to capture fresh URL params
      self.attribution.clearCache();
      self.page();
    };
    window.addEventListener('hashchange', this.hashchangeHandler);
  }

  /**
   * Setup page unload handler
   */
  private setupUnloadHandler(): void {
    // Use both events for maximum compatibility
    const handleUnload = () => {
      this.queue.forceFlush();
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        handleUnload();
      }
    });
  }

  /**
   * Get performance metrics
   */
  private getPerformanceMetrics(): PerformanceMetrics | null {
    if (!this.config.enablePerformanceTracking) return null;

    const metrics: PerformanceMetrics = {};

    try {
      // Try Navigation Timing v2
      if (performance && typeof performance.getEntriesByType === 'function') {
        const entries = performance.getEntriesByType('navigation');
        const nav = entries && entries[0] as any;
        
        if (nav) {
          metrics.pageLoadTime = Math.round(nav.loadEventEnd);
          metrics.domReadyTime = Math.round(nav.domContentLoadedEventEnd);
          metrics.firstByteTime = Math.round(nav.responseStart);
          metrics.dnsTime = Math.round(nav.domainLookupEnd - nav.domainLookupStart);
          metrics.tcpTime = Math.round(nav.connectEnd - nav.connectStart);
          metrics.requestTime = Math.round(nav.responseEnd - nav.requestStart);
          metrics.timeOnPage = Math.round(performance.now());
        }
      }
    } catch (error) {
      this.trackError(error as Error, { context: 'performance_metrics' });
    }

    return Object.keys(metrics).length > 0 ? metrics : null;
  }

  /**
   * Track error
   */
  private trackError(error: Error, context?: any): void {
    const errorInfo: ErrorInfo = {
      message: error.message || String(error),
      stack: error.stack,
      context,
      timestamp: new Date().toISOString(),
      url: window.location.href
    };

    this.errors.push(errorInfo);

    // Keep only recent errors
    if (this.errors.length > this.MAX_ERRORS) {
      this.errors = this.errors.slice(-this.MAX_ERRORS);
    }

    if (this.config.debug) {
      console.error('[Datalyr Error]', errorInfo);
    }
  }

  /**
   * Get errors
   */
  getErrors(): ErrorInfo[] {
    return [...this.errors];
  }

  /**
   * Get network status
   */
  getNetworkStatus(): NetworkStatus {
    return this.queue.getNetworkStatus();
  }

  /**
   * Load a container script by ID
   */
  loadScript(scriptId: string): void {
    if (this.container) {
      this.container.triggerCustomScript(scriptId);
    }
  }

  /**
   * Get loaded container scripts
   */
  getLoadedScripts(): string[] {
    if (this.container) {
      return this.container.getLoadedScripts();
    }
    return [];
  }

  /**
   * Debug logging
   */
  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[Datalyr]', ...args);
    }
  }

  /**
   * Destroy the SDK instance and cleanup resources
   */
  destroy(): void {
    // Restore original history methods (Issue #15)
    if (this.originalPushState) {
      history.pushState = this.originalPushState;
    }
    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState;
    }

    // Remove event listeners (Issue #15)
    if (this.popstateHandler) {
      window.removeEventListener('popstate', this.popstateHandler);
    }
    if (this.hashchangeHandler) {
      window.removeEventListener('hashchange', this.hashchangeHandler);
    }

    // Clean up queue
    if (this.queue) {
      this.queue.destroy();
    }

    // Clean up session
    if (this.session) {
      this.session.destroy();
    }

    // FIXED (ISSUE-02): Clean up sandboxed iframes to prevent memory leaks
    if (this.container) {
      this.container.cleanupAllIframes();
    }

    // Clean up auto-identify
    if (this.autoIdentify) {
      this.autoIdentify.destroy();
    }

    // SEC-03 Fix: Clean up encryption keys
    dataEncryption.destroy();

    // Clear any remaining data
    this.superProperties = {};
    this.userProperties = {};
    this.errors = [];
    this.initialized = false;

    this.log('SDK destroyed');
  }
}

// Create singleton instance
const datalyr = new Datalyr();

// Expose global API
if (typeof window !== 'undefined') {
  (window as any).datalyr = datalyr;
}

// Export default instance (also exported by name so both
// `import datalyr from '@datalyr/web'` and `import { datalyr } from '@datalyr/web'` work)
export { datalyr };
export default datalyr;