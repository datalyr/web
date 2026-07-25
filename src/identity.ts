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
  /** WEB-26: bumps whenever the persisted identity changes, so an in-flight
   *  encrypted write can tell it has been superseded. */
  private piiGeneration = 0;

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

    // 2. Raw URL visitor IDs are never identity authority. A syntactically
    // valid ID is still replayable/attacker-chosen and can merge two people.
    // Strip the legacy parameter and generate a fresh local identity below.
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('_dl_vid')) {
        this.stripUrlParam('_dl_vid');
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
   * TR-15 / FSR-107: tracking became allowed mid-session (optIn / consent grant). Start
   * persisting AND flush the current in-memory anon id to the cookie + localStorage now.
   * Without this, a visitor declined at init keeps a memory-only id, so that session's
   * events land under a visitor_id that vanishes on the next page load (attribution
   * fragmentation). Idempotent — a no-op once already persisting.
   */
  enablePersistence(): void {
    if (this.persistNewId) return;
    this.persistNewId = true;
    this.persistAnonymousId(this.anonymousId);
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
   * WEB-22 — is this user id personally identifying, and therefore not
   * something we may write to localStorage in the clear?
   *
   * The auto-identify path calls `identify(email, { email })`, so the raw
   * address became the `user_id` and was written unencrypted to `dl_user_id`.
   * Measured 2026-07-25: on the four workspaces using auto-identify, **every**
   * event carrying a `user_id` had an email in that column (20,502 / 20,502 on
   * `f6260736` over 7 days) — while the surrounding code went to real lengths to
   * encrypt the *same* address in `dl_auto_identified_email`.
   *
   * Deliberately narrow: an email is the case that actually occurs and the one
   * the SDK itself creates. Opaque application ids — the overwhelming majority —
   * keep the existing fast, synchronous, plaintext path with no behaviour change.
   */
  private static looksLikePII(userId: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userId);
  }

  /**
   * Persist the user id, encrypting it when it is PII.
   *
   * Three-way, and the ordering matters:
   *  - not PII        → plaintext `dl_user_id`, exactly as before (sync, always works)
   *  - PII + crypto   → encrypted `dl_user_id_pii`, and the plaintext key is REMOVED
   *  - PII, no crypto → memory only, and both keys removed
   *
   * That last branch is the deliberate trade. `crypto.subtle` is absent on
   * http:// and old browsers, and index.ts is explicit that encryption is for
   * PII-at-rest only and "must NOT gate event delivery". So we never block an
   * event — `this.userId` is set in memory first and every event still carries
   * it — we only decline to *persist* an address we cannot protect. The cost is
   * that a returning visitor on an insecure origin is re-identified by the next
   * `identify()` call rather than restored from storage; the alternative is
   * writing their email to disk in the clear, which is what this fixes.
   */
  private persistUserId(userId: string): void {
    if (!IdentityManager.looksLikePII(userId)) {
      storage.set('dl_user_id', userId);
      // WEB-26: a previous PII user's encrypted id must not linger once an
      // opaque id takes over. Reachable when identify('opaque') runs before
      // hydrateEncryptedUserId() has populated this.userId, so index.ts sees no
      // current user and skips its account-switch reset().
      this.piiGeneration += 1;
      storage.remove('dl_user_id_pii');
      return;
    }

    // Never leave a plaintext copy behind — including one written by a previous
    // SDK version before this fix existed.
    storage.remove('dl_user_id');

    // WEB-26: the encrypted write is async, and reset()/optOut()/consent
    // withdrawal are not. Without a generation guard this sequence resurrects a
    // logged-out user's email: identify(email) → write pending →
    // remove('dl_user_id_pii') deletes NOTHING because the write has not landed
    // → the write lands → next page load hydrates the previous user's address
    // and every event ships user_id = their email. Stamp the write and discard
    // it if the identity moved on while it was in flight.
    const generation = ++this.piiGeneration;
    storage.setEncrypted('dl_user_id_pii', userId)
      .then(() => {
        if (generation !== this.piiGeneration) storage.remove('dl_user_id_pii');
      })
      .catch(() => {
        // No crypto.subtle (http://, legacy browser) or a storage failure. Drop
        // the at-rest copy rather than falling back to plaintext PII — but only
        // if this write is still the current one, or we would delete a newer
        // user's successfully-written value.
        if (generation === this.piiGeneration) storage.remove('dl_user_id_pii');
      });
  }

  /**
   * Restore a PII user id that was persisted encrypted. Async by necessity, so
   * it cannot run in the constructor; index.ts calls it during init, right after
   * `dataEncryption.initialize()`.
   *
   * Never overwrites an id already established this page load — an explicit
   * `identify()` that has already run is fresher than anything on disk.
   */
  async hydrateEncryptedUserId(): Promise<void> {
    // WEB-26 (a) — migrate a plaintext address written by <= 1.7.7.
    //
    // persistUserId() only removes `dl_user_id` when identify() runs again, and
    // for the exact population this fix targets it never does:
    // AutoIdentifyManager.initialize() returns early while
    // `dl_auto_identified_email` exists (auto-identify.ts:88), so the callback
    // never fires. Without this the raw email would sit in localStorage forever
    // on every already-auto-identified browser.
    const legacy = storage.getString('dl_user_id');
    if (legacy && IdentityManager.looksLikePII(legacy)) {
      if (!this.userId) this.userId = legacy;
      this.persistUserId(legacy);
      return;
    }

    // WEB-26 (b) — recover a write that was dropped because encryption was not
    // keyed yet. index.ts sets `initialized = true` before initializeAsync()
    // finishes, so the documented `init(); identify(email)` pattern can reach
    // persistUserId() before dataEncryption has a key; that write rejects and
    // nothing is persisted. By here the key exists, so retry once.
    if (this.userId && IdentityManager.looksLikePII(this.userId)) {
      const alreadyStored = await storage.getEncrypted('dl_user_id_pii', null);
      if (!alreadyStored) this.persistUserId(this.userId);
      return;
    }

    if (this.userId) return;
    try {
      const stored = await storage.getEncrypted('dl_user_id_pii', null);
      if (typeof stored === 'string' && stored && !this.userId) {
        this.userId = stored;
      }
    } catch {
      // Undecryptable (rotated key, corrupt blob) — stay anonymous.
    }
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

    // Persist for future sessions. WEB-22: encrypted when the id is PII (the
    // auto-identify path makes it the raw email); plaintext otherwise.
    this.persistUserId(userId);

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
      this.persistUserId(userId);
    }

    return aliasData;
  }

  /**
   * Reset the current user (on logout)
   * Clears user_id but keeps anonymous_id
   */
  reset(): void {
    this.userId = null;
    // WEB-26: invalidate any encrypted write still in flight.
    this.piiGeneration += 1;
    storage.remove('dl_user_id');
    // WEB-22: the encrypted PII copy must go too, or a logout would leave the
    // previous user's email at rest.
    storage.remove('dl_user_id_pii');
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
