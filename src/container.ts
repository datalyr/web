/**
 * Container Script Manager
 * Loads and manages third-party tracking scripts and pixels
 */

import { storage } from './storage';

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
  private workspaceId: string;
  private endpoint: string;
  private debug: boolean;
  private initialized = false;

  constructor(options: {
    workspaceId: string;
    endpoint?: string;
    debug?: boolean;
  }) {
    this.workspaceId = options.workspaceId;
    // Container scripts always use the app endpoint, not ingest
    this.endpoint = this.extractAppEndpoint(options.endpoint);
    this.debug = options.debug || false;
    
    // Load session scripts from storage
    const sessionScripts = storage.get('dl_session_scripts', []);
    this.sessionLoadedScripts = new Set(sessionScripts);
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
      
      // Store scripts and pixels
      this.scripts = data.scripts || [];
      this.pixels = data.pixels || null;
      
      // Initialize pixels if configured
      if (this.pixels) {
        this.initializePixels();
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
   * Load inline JavaScript
   */
  private loadInlineScript(script: ContainerScript): void {
    // Basic XSS protection - ensure content doesn't contain obvious malicious patterns
    if (this.containsMaliciousPatterns(script.content)) {
      this.log('Blocked potentially malicious inline script:', script.id);
      return;
    }
    
    const scriptElement = document.createElement('script');
    scriptElement.textContent = script.content;
    scriptElement.dataset.datalyrScript = script.id;
    scriptElement.setAttribute('data-nonce', this.generateNonce());
    document.head.appendChild(scriptElement);
  }

  /**
   * Load external JavaScript
   */
  private loadExternalScript(script: ContainerScript): void {
    // Validate URL before loading
    if (!this.isValidScriptUrl(script.content)) {
      this.log('Blocked invalid script URL:', script.content);
      return;
    }
    
    const scriptElement = document.createElement('script');
    scriptElement.src = script.content;
    scriptElement.dataset.datalyrScript = script.id;
    
    // Apply settings
    if (script.settings) {
      if (script.settings.async !== false) scriptElement.async = true;
      if (script.settings.defer) scriptElement.defer = true;
      if (script.settings.integrity) scriptElement.integrity = script.settings.integrity;
      if (script.settings.crossorigin) scriptElement.crossOrigin = script.settings.crossorigin;
    } else {
      // Default to async for better performance
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
  private initializePixels(): void {
    if (!this.pixels) return;
    
    // Initialize Meta Pixel
    if (this.pixels.meta?.enabled && this.pixels.meta.pixel_id) {
      this.initializeMetaPixel(this.pixels.meta);
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
   */
  private initializeMetaPixel(config: any): void {
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
      
      // Initialize pixel
      (window as any).fbq('init', config.pixel_id);
      (window as any).fbq('track', 'PageView');
      
      this.log('Meta Pixel initialized:', config.pixel_id);
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
  trackToPixels(eventName: string, properties: any = {}): void {
    // Track to Meta Pixel
    if (this.pixels?.meta?.enabled && (window as any).fbq) {
      try {
        (window as any).fbq('track', eventName, properties);
      } catch (error) {
        this.log('Error tracking Meta Pixel event:', error);
      }
    }
    
    // Track to Google Tag
    if (this.pixels?.google?.enabled && (window as any).gtag) {
      try {
        (window as any).gtag('event', eventName, properties);
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
        
        const tiktokEvent = tiktokEventMap[eventName] || eventName;
        (window as any).ttq.track(tiktokEvent, properties);
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
   * Extract app endpoint from ingest endpoint
   */
  private extractAppEndpoint(endpoint?: string): string {
    if (!endpoint) {
      return 'https://app.datalyr.com';
    }
    
    // If it's already an app endpoint, use it
    if (endpoint.includes('app.datalyr.com')) {
      return endpoint;
    }
    
    // Convert ingest endpoint to app endpoint
    if (endpoint.includes('ingest.datalyr.com')) {
      return 'https://app.datalyr.com';
    }
    
    // For local development
    if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
      // Assume app is on port 3000 if ingest is on 3001
      return endpoint.replace(':3001', ':3000').replace('/ingest', '');
    }
    
    // For custom endpoints, try to extract the base domain
    try {
      const url = new URL(endpoint);
      return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
    } catch {
      return 'https://app.datalyr.com';
    }
  }

  /**
   * Check for malicious patterns in inline scripts
   */
  private containsMaliciousPatterns(content: string): boolean {
    // Basic patterns that might indicate malicious content
    const dangerousPatterns = [
      /<script[^>]*>/gi,  // Script tags within content
      /document\.cookie/gi,  // Direct cookie access
      /eval\s*\(/gi,  // eval usage
      /Function\s*\(/gi,  // Function constructor
      /innerHTML\s*=/gi,  // Direct innerHTML assignment
      /document\.write/gi,  // document.write usage
    ];
    
    return dangerousPatterns.some(pattern => pattern.test(content));
  }

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
   * Generate a nonce for CSP
   */
  private generateNonce(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array));
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