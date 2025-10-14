/**
 * Datalyr Web SDK
 * Modern attribution tracking for web applications
 */

import { IdentityManager } from './identity';
import { SessionManager } from './session';
import { AttributionManager } from './attribution';
import { EventQueue } from './queue';
import { FingerprintCollector } from './fingerprint';
import { storage, cookies, CookieStorage } from './storage';
import { ContainerManager } from './container';
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
  private superProperties: Record<string, any> = {};
  private userProperties: Record<string, any> = {};
  private optedOut = false;
  private initialized = false;
  private errors: ErrorInfo[] = [];
  private MAX_ERRORS = 50;
  private heavyFingerprintCollected = false;

  constructor() {
    // Check for opt-out cookie on instantiation using default cookie instance
    this.optedOut = cookies.get('__dl_opt_out') === 'true';
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
      sessionTimeout: 30 * 60 * 1000,
      trackSessions: true,
      attributionWindow: 30 * 24 * 60 * 60 * 1000,
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

    // Load stored user properties
    this.userProperties = storage.get('dl_user_traits', {});

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
      this.container.init().catch(error => {
        this.log('Container initialization failed:', error);
      });
    }

    // Track initial page view if enabled
    if (this.config.trackPageViews) {
      this.page();
    }

    // Setup page unload handler
    this.setupUnloadHandler();

    // Initialize plugins
    if (this.config.plugins) {
      for (const plugin of this.config.plugins) {
        try {
          plugin.initialize(this);
          this.log(`Plugin initialized: ${plugin.name}`);
        } catch (error) {
          this.trackError(error as Error, { plugin: plugin.name });
        }
      }
    }

    this.initialized = true;
    this.log('SDK initialized');
  }

  /**
   * Track an event
   */
  track(eventName: string, properties: EventProperties = {}): void {
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
    if (!this.shouldTrack()) return;
    if (!userId) {
      console.warn('[Datalyr] identify() called without userId');
      return;
    }

    try {
      // Update identity
      const identityLink = this.identity.identify(userId, traits);

      // Store user properties
      this.userProperties = { ...this.userProperties, ...traits };
      storage.set('dl_user_traits', this.userProperties);

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
    this.track('$group', {
      group_id: groupId,
      traits
    });
  }

  /**
   * Alias one ID to another
   */
  alias(userId: string, previousId?: string): void {
    const aliasData = this.identity.alias(userId, previousId);
    this.track('$alias', aliasData);
  }

  /**
   * Reset the current user
   */
  reset(): void {
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
    this.optedOut = true;
    cookies.set('__dl_opt_out', 'true', this.config.cookieExpires);
    this.queue.clear();
    this.log('User opted out');
  }

  /**
   * Opt in to tracking
   */
  optIn(): void {
    this.optedOut = false;
    cookies.set('__dl_opt_out', 'false', this.config.cookieExpires);
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
        fingerprint: fingerprintData,
        device_fingerprint: fingerprintData // Snake case alias
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

    // Create payload with both camelCase and snake_case fields
    const identityFields = this.identity.getIdentityFields();
    const eventId = generateUUID();
    
    // Ensure we have all required identity fields
    const distinctId = identityFields.distinct_id;
    const anonymousId = identityFields.anonymous_id;
    const visitorId = identityFields.visitor_id || anonymousId;
    const sessionId = identityFields.session_id;
    
    const payload: IngestEventPayload = {
      // Required fields
      workspaceId: this.config.workspaceId,
      workspace_id: this.config.workspaceId, // Snake case alias
      eventId: eventId,
      event_id: eventId, // Snake case alias (same ID)
      eventName,
      event_name: eventName, // Snake case alias
      eventData,
      event_data: eventData, // Snake case alias
      source: 'web',
      timestamp: new Date().toISOString(),
      
      // Identity fields (explicit to satisfy TypeScript)
      distinct_id: distinctId,
      anonymous_id: anonymousId,
      visitor_id: visitorId,
      visitorId: visitorId,
      user_id: identityFields.user_id,
      canonical_id: identityFields.canonical_id,
      sessionId: sessionId,
      session_id: sessionId,
      
      // Resolution metadata
      resolution_method: 'browser_sdk',
      resolution_confidence: 1.0,
      
      // SDK metadata
      sdk_version: '1.0.0',
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
   */
  private setupSPATracking(): void {
    // Store original methods
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const self = this;

    // Override pushState
    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      setTimeout(() => {
        self.page();
      }, 0);
    };

    // Override replaceState
    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      setTimeout(() => {
        self.page();
      }, 0);
    };

    // Listen for popstate
    window.addEventListener('popstate', () => {
      setTimeout(() => {
        this.page();
      }, 0);
    });

    // Listen for hashchange
    window.addEventListener('hashchange', () => {
      this.page();
    });
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
    // Clean up queue
    if (this.queue) {
      this.queue.destroy();
    }
    
    // Clean up session
    if (this.session) {
      this.session.destroy();
    }
    
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