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

        // Initialize container manager if enabled
        if (this.config.enableContainer !== false) {
          this.container = new ContainerManager({
            workspaceId: this.config.workspaceId,
            endpoint: this.config.endpoint,
            debug: this.config.debug
          });

          // Initialize container asynchronously
          await this.container.init().catch(error => {
            this.log('Container initialization failed:', error);
          });
        }

        // Initialize auto-identify if explicitly enabled (opt-in)
        if (this.config.autoIdentify === true) {
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

      // Create event payload
      const payload = this.createEventPayload(eventName, properties);

      // Queue event
      this.queue.enqueue(payload);

      // Track to third-party pixels if container is initialized
      if (this.container) {
        this.container.trackToPixels(eventName, properties);
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
   * Track a screen view (for SPAs)
   */
  screen(screenName: string, properties: Record<string, any> = {}): void {
    this.track('screen_view', {
      screen_name: screenName,
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
   * Create event payload
   */
  private createEventPayload(eventName: string, properties: Record<string, any>): IngestEventPayload {
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
    const eventId = generateUUID();

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

      // SDK metadata
      sdk_version: '1.2.0',
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

// Export default instance
export default datalyr;