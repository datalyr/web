/**
 * Identity Management Module
 * Handles anonymous_id, user_id, and identity resolution
 */

import { storage, cookies } from './storage';
import { generateUUID, getRootDomain } from './utils';

export class IdentityManager {
  private anonymousId: string;
  private userId: string | null = null;
  private sessionId: string | null = null;
  // FSR-107: when tracking is disallowed at init (opt-out / GPC / DNT), a freshly
  // generated id is kept in MEMORY only — no cookie / localStorage write. Events don't
  // send anyway; a later optIn()/consent grant persists on the next identify/reset.
  private persistNewId: boolean;

  constructor(options: { persistNewId?: boolean } = {}) {
    this.persistNewId = options.persistNewId !== false;
    this.anonymousId = this.getOrCreateAnonymousId();
    this.userId = this.getStoredUserId();
  }

  /**
   * Get or create anonymous ID (device/browser identifier)
   */
  private getOrCreateAnonymousId(): string {
    // 1. An EXISTING identity always wins — check the root-domain cookie (works across
    //    subdomains) then localStorage. FSR-50: a persisted visitor must NEVER be
    //    silently overwritten by a ?_dl_vid in the URL, or shared links would merge
    //    unrelated visitors (identity takeover). The CC bridge (restoreFromURL) writes
    //    this cookie BEFORE us, so the storefront visitor_id still wins there.
    let anonymousId = cookies.get('__dl_visitor_id');
    if (anonymousId) {
      storage.set('dl_anonymous_id', anonymousId); // sync to localStorage
      return anonymousId;
    }
    anonymousId = storage.getString('dl_anonymous_id'); // FSR-17: raw string, no JSON.parse
    if (anonymousId) {
      this.setRootDomainCookie('__dl_visitor_id', anonymousId);
      return anonymousId;
    }

    // 2. Fresh visitor (no persisted id): accept a cross-domain bridge id from the URL,
    //    but ONLY a well-formed anon_<uuid> — reject arbitrary / oversized values (a
    //    multi-KB or attacker-crafted _dl_vid was previously persisted verbatim). Strip
    //    it from the address bar so a re-shared URL can't merge the next visitor. (FSR-50)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const urlVisitorId = urlParams.get('_dl_vid');
      if (urlVisitorId && this.isValidAnonymousId(urlVisitorId)) {
        this.stripUrlParam('_dl_vid');
        this.persistAnonymousId(urlVisitorId);
        return urlVisitorId;
      }
    } catch (e) {
      // URL parsing failed - continue to generate a fresh id
      console.warn('[Datalyr] Failed to parse URL for _dl_vid:', e);
    }

    // 3. Generate a new ID (persisted unless tracking is disallowed at init — FSR-107).
    anonymousId = `anon_${generateUUID()}`;
    this.persistAnonymousId(anonymousId);
    return anonymousId;
  }

  /**
   * Persist a freshly-adopted/generated anonymous id to the root-domain cookie +
   * localStorage. Gated by persistNewId (FSR-107: don't write a tracking identifier for
   * an opted-out / GPC / DNT visitor at init).
   */
  private persistAnonymousId(id: string): void {
    if (!this.persistNewId) return;
    this.setRootDomainCookie('__dl_visitor_id', id);
    storage.set('dl_anonymous_id', id);
  }

  /**
   * Whether a `_dl_vid` value is a well-formed Datalyr anonymous id (anon_ + UUID).
   * The length is bounded by the pattern, so an oversized/garbage value is rejected.
   * (FSR-50)
   */
  private isValidAnonymousId(id: string): boolean {
    return /^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  /**
   * Remove a query param from the current URL via history.replaceState (best-effort).
   * Used so a consumed `_dl_vid` doesn't linger in the address bar and get re-shared.
   * (FSR-50)
   */
  private stripUrlParam(param: string): void {
    try {
      if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
      const url = new URL(window.location.href);
      if (!url.searchParams.has(param)) return;
      url.searchParams.delete(param);
      const search = url.searchParams.toString();
      const newUrl = url.pathname + (search ? '?' + search : '') + url.hash;
      window.history.replaceState(window.history.state, '', newUrl);
    } catch {
      // best-effort — never block init on URL rewrite
    }
  }

  /**
   * Set a root domain cookie for cross-subdomain tracking
   */
  private setRootDomainCookie(name: string, value: string): void {
    try {
      const rootDomain = getRootDomain();
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      const encodedValue = encodeURIComponent(value);

      // Set cookie with root domain, 1 year expiry
      document.cookie = `${name}=${encodedValue}; domain=${rootDomain}; path=/; max-age=31536000; SameSite=Lax${secure}`;

      // Verify cookie was set successfully (cookies.get already decodes)
      const verifyValue = cookies.get(name);
      if (verifyValue !== value) {
        // Fallback: try without domain (current subdomain only)
        document.cookie = `${name}=${encodedValue}; path=/; max-age=31536000; SameSite=Lax${secure}`;
      }
    } catch (e) {
      console.error('[Datalyr] Error setting root domain cookie:', e);
      // Still try to set without domain as fallback
      try {
        const secure = location.protocol === 'https:' ? '; Secure' : '';
        const encodedValue = encodeURIComponent(value);
        document.cookie = `${name}=${encodedValue}; path=/; max-age=31536000; SameSite=Lax${secure}`;
      } catch (fallbackError) {
        console.error('[Datalyr] Failed to set cookie even without domain:', fallbackError);
      }
    }
  }

  /**
   * Get stored user ID from previous session
   */
  private getStoredUserId(): string | null {
    // FSR-17: getString (not get) so a numeric-looking user_id ('12345') doesn't come
    // back as a JS number after reload, and a 16+-digit snowflake id isn't precision-
    // corrupted by JSON.parse — both would fragment identity from the second page on.
    return storage.getString('dl_user_id');
  }

  /**
   * Get the anonymous ID
   */
  getAnonymousId(): string {
    return this.anonymousId;
  }

  /**
   * Get the user ID (if identified)
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Get the distinct ID (primary identifier)
   * Returns user_id if identified, otherwise anonymous_id
   */
  getDistinctId(): string {
    return this.userId || this.anonymousId;
  }

  /**
   * Get canonical ID (alias for distinct_id)
   */
  getCanonicalId(): string {
    return this.getDistinctId();
  }

  /**
   * Set the session ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get the session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Identify a user
   * Links anonymous_id to user_id
   */
  identify(userId: string, traits: Record<string, any> = {}): Record<string, any> {
    if (!userId) {
      console.warn('[Datalyr] identify() called without userId');
      return {};
    }

    const previousUserId = this.userId;
    this.userId = userId;

    // Persist for future sessions
    storage.set('dl_user_id', userId);

    // Return identity link data (will be sent as $identify event)
    return {
      anonymous_id: this.anonymousId,
      user_id: userId,
      previous_id: previousUserId,
      traits: traits,
      identified_at: new Date().toISOString(),
      resolution_method: 'identify_call'
    };
  }

  /**
   * Alias one ID to another
   */
  alias(userId: string, previousId?: string): Record<string, any> {
    const aliasData = {
      userId,
      previousId: previousId || this.anonymousId,
      aliased_at: new Date().toISOString()
    };

    // Update current user ID if aliasing to current anonymous ID
    if (!previousId || previousId === this.anonymousId) {
      this.userId = userId;
      storage.set('dl_user_id', userId);
    }

    return aliasData;
  }

  /**
   * Reset the current user (on logout)
   * Clears user_id but keeps anonymous_id
   */
  reset(): void {
    this.userId = null;
    storage.remove('dl_user_id');
    storage.remove('dl_user_traits');

    // Generate new anonymous ID for privacy
    this.anonymousId = `anon_${generateUUID()}`;
    storage.set('dl_anonymous_id', this.anonymousId);

    // Update root domain cookie with new ID
    this.setRootDomainCookie('__dl_visitor_id', this.anonymousId);
  }

  /**
   * Get all identity fields for event payload
   */
  getIdentityFields(): Record<string, any> {
    return {
      // Modern fields
      distinct_id: this.getDistinctId(),
      anonymous_id: this.anonymousId,
      user_id: this.userId,
      
      // Legacy compatibility
      visitor_id: this.anonymousId,
      visitorId: this.anonymousId,
      canonical_id: this.getCanonicalId(),
      
      // Session
      session_id: this.sessionId,
      sessionId: this.sessionId,
      
      // Identity resolution
      resolution_method: 'browser_sdk',
      resolution_confidence: 1.0
    };
  }
}