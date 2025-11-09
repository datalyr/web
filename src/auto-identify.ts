/**
 * Auto-Identify Module
 *
 * Automatically captures user identity (email) from:
 * 1. Fetch/XHR API requests (email in request/response)
 * 2. Form submissions (email inputs)
 * 3. Shopify-specific endpoints (/account.json)
 *
 * SECURITY:
 * - Email validation to prevent false positives
 * - Whitelist approach for trusted domains
 * - Rate limiting to prevent spam
 * - Privacy controls integration
 */

import { storage } from './storage';

interface AutoIdentifyConfig {
  enabled?: boolean;
  captureFromForms?: boolean;
  captureFromAPI?: boolean;
  captureFromShopify?: boolean;
  trustedDomains?: string[];
  debug?: boolean;
}

export class AutoIdentifyManager {
  private config: Required<AutoIdentifyConfig>;
  private identifyCallback?: (email: string, source: string) => void;
  private originalFetch?: typeof window.fetch;
  private originalXHROpen?: typeof XMLHttpRequest.prototype.open;
  private originalXHRSend?: typeof XMLHttpRequest.prototype.send;
  private formListeners: Array<{ element: HTMLElement; handler: EventListener }> = [];
  private lastIdentifyTime = 0;
  private RATE_LIMIT_MS = 5000; // Don't auto-identify more than once per 5 seconds
  private shopifyCheckInterval?: ReturnType<typeof setInterval>;

  constructor(config: AutoIdentifyConfig = {}) {
    this.config = {
      enabled: config.enabled !== false,
      captureFromForms: config.captureFromForms !== false,
      captureFromAPI: config.captureFromAPI !== false,
      captureFromShopify: config.captureFromShopify !== false,
      trustedDomains: config.trustedDomains || [],
      debug: config.debug || false
    };
  }

  /**
   * Initialize auto-identify system
   */
  initialize(identifyCallback: (email: string, source: string) => void): void {
    if (!this.config.enabled) {
      this.log('Auto-identify disabled');
      return;
    }

    this.identifyCallback = identifyCallback;

    // Check if already identified
    const existingEmail = storage.get('dl_auto_identified_email');
    if (existingEmail) {
      this.log('User already auto-identified:', existingEmail);
      return;
    }

    // Setup monitoring
    if (this.config.captureFromForms) {
      this.setupFormMonitoring();
    }

    if (this.config.captureFromAPI) {
      this.setupFetchInterception();
      this.setupXHRInterception();
    }

    if (this.config.captureFromShopify) {
      this.setupShopifyMonitoring();
    }

    this.log('Auto-identify initialized');
  }

  /**
   * Setup form monitoring for email capture
   */
  private setupFormMonitoring(): void {
    // Monitor existing forms
    this.scanForEmailForms();

    // Watch for new forms (SPAs)
    const observer = new MutationObserver(() => {
      this.scanForEmailForms();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.log('Form monitoring active');
  }

  /**
   * Scan DOM for forms with email inputs
   */
  private scanForEmailForms(): void {
    const forms = document.querySelectorAll('form');

    forms.forEach(form => {
      // Skip if already listening
      if (this.formListeners.some(l => l.element === form)) {
        return;
      }

      // Check if form has email input
      const emailInput = form.querySelector<HTMLInputElement>(
        'input[type="email"], input[name*="email" i], input[id*="email" i]'
      );

      if (emailInput) {
        const handler = (e: Event) => this.handleFormSubmit(e, form);
        form.addEventListener('submit', handler);
        this.formListeners.push({ element: form, handler });
        this.log('Monitoring form:', form);
      }
    });
  }

  /**
   * Handle form submission
   */
  private handleFormSubmit(_event: Event, form: HTMLFormElement): void {
    try {
      // Find email input
      const emailInput = form.querySelector<HTMLInputElement>(
        'input[type="email"], input[name*="email" i], input[id*="email" i]'
      );

      if (!emailInput) return;

      const email = emailInput.value.trim();

      if (this.isValidEmail(email)) {
        this.log('Email captured from form:', email);
        this.triggerIdentify(email, 'form');
      }
    } catch (error) {
      this.log('Error handling form submit:', error);
    }
  }

  /**
   * Setup fetch interception for API email capture
   */
  private setupFetchInterception(): void {
    if (typeof window.fetch !== 'function') return;

    this.originalFetch = window.fetch;
    const self = this;

    window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // Check if trusted domain
      if (!self.isTrustedDomain(url)) {
        return self.originalFetch!.call(window, input, init);
      }

      try {
        // Check request body for email
        if (init?.body) {
          self.extractEmailFromData(init.body, 'api-request');
        }

        // Make actual request
        const response = self.originalFetch!.call(window, input, init);

        // Check response for email
        response.then(async (res) => {
          if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
            try {
              const clone = res.clone();
              const data = await clone.json();
              self.extractEmailFromData(data, 'api-response');
            } catch (error) {
              // Ignore JSON parse errors
            }
          }
        }).catch(() => {
          // Ignore response errors
        });

        return response;
      } catch (error) {
        self.log('Error intercepting fetch:', error);
        return self.originalFetch!.call(window, input, init);
      }
    };

    this.log('Fetch interception active');
  }

  /**
   * Setup XHR interception for API email capture
   */
  private setupXHRInterception(): void {
    if (typeof XMLHttpRequest === 'undefined') return;

    const self = this;
    this.originalXHROpen = XMLHttpRequest.prototype.open;
    this.originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
      (this as any)._datalyrUrl = typeof url === 'string' ? url : url.href;
      return self.originalXHROpen!.apply(this, [method, url, ...args] as any);
    };

    XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
      const url = (this as any)._datalyrUrl;

      if (url && self.isTrustedDomain(url)) {
        // Check request body
        if (body) {
          self.extractEmailFromData(body, 'api-request');
        }

        // Monitor response
        this.addEventListener('load', function() {
          if (this.status >= 200 && this.status < 300) {
            try {
              const contentType = this.getResponseHeader('content-type');
              if (contentType?.includes('application/json')) {
                const data = JSON.parse(this.responseText);
                self.extractEmailFromData(data, 'api-response');
              }
            } catch (error) {
              // Ignore parse errors
            }
          }
        });
      }

      return self.originalXHRSend!.call(this, body);
    };

    this.log('XHR interception active');
  }

  /**
   * Setup Shopify-specific monitoring
   */
  private setupShopifyMonitoring(): void {
    // Detect Shopify
    if (!this.isShopify()) {
      return;
    }

    this.log('Shopify detected, setting up monitoring');

    // Try to fetch customer data immediately
    this.checkShopifyCustomer();

    // Check periodically (in case customer logs in later)
    this.shopifyCheckInterval = setInterval(() => {
      this.checkShopifyCustomer();
    }, 10000); // Check every 10 seconds

    this.log('Shopify monitoring active');
  }

  /**
   * Check if running on Shopify
   */
  private isShopify(): boolean {
    return !!(
      (window as any).Shopify ||
      document.querySelector('meta[name="shopify-checkout-api-token"]') ||
      window.location.hostname.includes('.myshopify.com')
    );
  }

  /**
   * Check Shopify customer endpoint for email
   */
  private async checkShopifyCustomer(): Promise<void> {
    try {
      const response = await fetch('/account.json', {
        credentials: 'same-origin'
      });

      if (response.ok) {
        const data = await response.json();

        if (data?.customer?.email) {
          this.log('Email captured from Shopify:', data.customer.email);
          this.triggerIdentify(data.customer.email, 'shopify');

          // Stop checking once we have email
          if (this.shopifyCheckInterval) {
            clearInterval(this.shopifyCheckInterval);
            this.shopifyCheckInterval = undefined;
          }
        }
      }
    } catch (error) {
      // User not logged in or endpoint unavailable
      this.log('Shopify customer check failed:', error);
    }
  }

  /**
   * Extract email from data (object, string, FormData)
   */
  private extractEmailFromData(data: any, source: string): void {
    try {
      let emails: string[] = [];

      if (typeof data === 'string') {
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(data);
          emails = this.findEmailsInObject(parsed);
        } catch {
          // Try to extract from string directly
          const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const matches = data.match(emailPattern);
          if (matches) {
            emails = matches;
          }
        }
      } else if (data instanceof FormData) {
        // Extract from FormData
        data.forEach((value) => {
          if (typeof value === 'string' && this.isValidEmail(value)) {
            emails.push(value);
          }
        });
      } else if (typeof data === 'object' && data !== null) {
        // Extract from object
        emails = this.findEmailsInObject(data);
      }

      // Trigger identify for first valid email
      if (emails.length > 0) {
        const email = emails[0];
        this.log(`Email found in ${source}:`, email);
        this.triggerIdentify(email, 'api');
      }
    } catch (error) {
      this.log('Error extracting email from data:', error);
    }
  }

  /**
   * Recursively find emails in object
   */
  private findEmailsInObject(obj: any, depth = 0): string[] {
    if (depth > 5) return []; // Prevent infinite recursion

    const emails: string[] = [];

    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) continue;

      const value = obj[key];

      // Check if key suggests email field
      if (/email/i.test(key) && typeof value === 'string' && this.isValidEmail(value)) {
        emails.push(value);
      }
      // Recursively check nested objects
      else if (typeof value === 'object' && value !== null) {
        emails.push(...this.findEmailsInObject(value, depth + 1));
      }
    }

    return emails;
  }

  /**
   * Check if domain is trusted for auto-identify
   */
  private isTrustedDomain(url: string): boolean {
    try {
      const urlObj = new URL(url, window.location.origin);

      // Always trust same origin
      if (urlObj.origin === window.location.origin) {
        return true;
      }

      // Check trusted domains list
      if (this.config.trustedDomains.length === 0) {
        // If no trusted domains specified, only trust same origin
        return false;
      }

      return this.config.trustedDomains.some(domain => {
        return urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`);
      });
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    if (!email || typeof email !== 'string') return false;

    // Basic email validation
    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailPattern.test(email)) return false;

    // Exclude common test/dummy emails
    const dummyPatterns = [
      /test@/i,
      /example@/i,
      /demo@/i,
      /fake@/i,
      /@test\./i,
      /@example\./i
    ];

    if (dummyPatterns.some(pattern => pattern.test(email))) {
      return false;
    }

    return true;
  }

  /**
   * Trigger identify with rate limiting
   */
  private triggerIdentify(email: string, source: string): void {
    // Rate limiting
    const now = Date.now();
    if (now - this.lastIdentifyTime < this.RATE_LIMIT_MS) {
      this.log('Rate limited, skipping identify');
      return;
    }

    // Check if already identified
    const existingEmail = storage.get('dl_auto_identified_email');
    if (existingEmail === email) {
      this.log('Already identified with this email');
      return;
    }

    // Store email to prevent duplicate identification
    storage.set('dl_auto_identified_email', email);
    this.lastIdentifyTime = now;

    // Trigger callback
    if (this.identifyCallback) {
      this.log(`Auto-identifying user: ${email} (source: ${source})`);
      this.identifyCallback(email, source);
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    // Restore original fetch
    if (this.originalFetch) {
      window.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }

    // Restore original XHR
    if (this.originalXHROpen) {
      XMLHttpRequest.prototype.open = this.originalXHROpen;
      this.originalXHROpen = undefined;
    }

    if (this.originalXHRSend) {
      XMLHttpRequest.prototype.send = this.originalXHRSend;
      this.originalXHRSend = undefined;
    }

    // Remove form listeners
    this.formListeners.forEach(({ element, handler }) => {
      element.removeEventListener('submit', handler);
    });
    this.formListeners = [];

    // Clear Shopify interval
    if (this.shopifyCheckInterval) {
      clearInterval(this.shopifyCheckInterval);
      this.shopifyCheckInterval = undefined;
    }

    this.log('Auto-identify destroyed');
  }

  /**
   * Debug logging
   */
  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[Datalyr Auto-Identify]', ...args);
    }
  }
}
