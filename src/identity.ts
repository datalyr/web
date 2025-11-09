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

  constructor() {
    this.anonymousId = this.getOrCreateAnonymousId();
    this.userId = this.getStoredUserId();
  }

  /**
   * Get or create anonymous ID (device/browser identifier)
   */
  private getOrCreateAnonymousId(): string {
    // 1. Check root domain cookie first (works across subdomains)
    let anonymousId = cookies.get('__dl_visitor_id');

    if (anonymousId) {
      // Found in cookie - sync to localStorage
      storage.set('dl_anonymous_id', anonymousId);
      return anonymousId;
    }

    // 2. Check localStorage (fallback for cookie issues)
    anonymousId = storage.get('dl_anonymous_id');

    if (anonymousId) {
      // Found in localStorage - set root domain cookie
      this.setRootDomainCookie('__dl_visitor_id', anonymousId);
      return anonymousId;
    }

    // 3. Generate new ID
    anonymousId = `anon_${generateUUID()}`;

    // 4. Store in both cookie (primary) and localStorage (backup)
    this.setRootDomainCookie('__dl_visitor_id', anonymousId);
    storage.set('dl_anonymous_id', anonymousId);

    return anonymousId;
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
    return storage.get('dl_user_id');
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