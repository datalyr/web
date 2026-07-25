/**
 * Storage Module
 * Safe storage wrapper with fallbacks for Safari private mode
 * SEC-03 Fix: Added encryption support for PII data
 */

import { dataEncryption } from './encryption';

interface StorageWrapper {
  get(key: string, defaultValue?: any): any;
  getString(key: string, defaultValue?: string | null): string | null;
  set(key: string, value: any): boolean;
  remove(key: string): boolean;
  keys(): string[];
  // SEC-03: Encrypted storage methods
  getEncrypted(key: string, defaultValue?: any): Promise<any>;
  setEncrypted(key: string, value: any): Promise<boolean>;
}

class SafeStorage implements StorageWrapper {
  private storage: Storage | null;
  private memory: Map<string, string> = new Map();
  private prefix = 'dl_';

  constructor(storage?: Storage) {
    // Test if storage is available
    try {
      if (!storage) throw new Error('no storage'); // server / SSR
      const testKey = 'dl_test__' + Math.random();
      storage.setItem(testKey, '1');
      storage.removeItem(testKey);
      this.storage = storage;
    } catch {
      // Storage not available (server-side render, Safari private mode, etc.)
      this.storage = null;
      // Only warn in the browser — on the server there's intentionally no
      // storage and the SDK does no real work until init() runs client-side.
      if (typeof window !== 'undefined') {
        console.warn('[Datalyr] Storage not available, using memory fallback');
      }
    }
  }

  get(key: string, defaultValue: any = null): any {
    const fullKey = this.prefix + key;
    
    try {
      if (this.storage) {
        const value = this.storage.getItem(fullKey);
        if (value === null) return defaultValue;
        
        // Try to parse JSON
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } else {
        const value = this.memory.get(fullKey);
        if (value === undefined) return defaultValue;
        
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
    } catch {
      return defaultValue;
    }
  }

  /**
   * Get a value as a RAW string, skipping the JSON.parse that get() applies.
   *
   * FSR-17: get() blindly JSON.parses, so a stored user_id like '12345' comes back as
   * the NUMBER 12345 after reload, and a 16+-digit snowflake id ('1234567890123456789')
   * is silently precision-corrupted (→ 1234567890123456800) — permanent identity
   * fragmentation. Identifiers (dl_user_id, dl_anonymous_id, dl_auto_identified_email)
   * must round-trip as the exact string they were stored as; use this for them.
   */
  getString(key: string, defaultValue: string | null = null): string | null {
    const fullKey = this.prefix + key;
    try {
      const value = this.storage
        ? this.storage.getItem(fullKey)
        : (this.memory.has(fullKey) ? this.memory.get(fullKey)! : null);
      if (value === null || value === undefined) return defaultValue;
      // Values written by set() with a string are stored raw (unquoted); return as-is.
      // A value written as JSON (quoted string) is unwrapped so callers always get the
      // logical string, never a quoted one.
      if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
        try {
          const parsed = JSON.parse(value);
          if (typeof parsed === 'string') return parsed;
        } catch {
          // fall through to raw
        }
      }
      return value;
    } catch {
      return defaultValue;
    }
  }

  set(key: string, value: any): boolean {
    const fullKey = this.prefix + key;
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    
    try {
      if (this.storage) {
        this.storage.setItem(fullKey, stringValue);
        return true;
      } else {
        this.memory.set(fullKey, stringValue);
        return true;
      }
    } catch (e) {
      // Quota exceeded or other error
      console.warn('[Datalyr] Failed to store:', key, e);
      // Try memory fallback
      this.memory.set(fullKey, stringValue);
      return false;
    }
  }

  remove(key: string): boolean {
    const fullKey = this.prefix + key;
    
    try {
      if (this.storage) {
        this.storage.removeItem(fullKey);
        return true;
      } else {
        this.memory.delete(fullKey);
        return true;
      }
    } catch {
      return false;
    }
  }

  keys(): string[] {
    try {
      if (this.storage) {
        const keys: string[] = [];
        for (let i = 0; i < this.storage.length; i++) {
          const key = this.storage.key(i);
          if (key && key.startsWith(this.prefix)) {
            keys.push(key.slice(this.prefix.length));
          }
        }
        return keys;
      } else {
        return Array.from(this.memory.keys())
          .filter(k => k.startsWith(this.prefix))
          .map(k => k.slice(this.prefix.length));
      }
    } catch {
      return [];
    }
  }

  /**
   * Migrate data from legacy '__dl_dl_*' keys to new 'dl_*' keys
   *
   * This fixes the double-prefix issue from earlier SDK versions.
   * Called automatically during SDK initialization.
   *
   * @returns Number of keys migrated
   */
  migrateFromLegacyPrefix(): number {
    if (!this.storage) {
      return 0; // Can't migrate in memory-only mode
    }

    let migratedCount = 0;
    const legacyPrefix = '__dl_dl_';

    try {
      // Find all legacy keys
      const legacyKeys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key && key.startsWith(legacyPrefix)) {
          legacyKeys.push(key);
        }
      }

      // Migrate each legacy key
      legacyKeys.forEach(legacyKey => {
        try {
          // Get value from legacy key
          const value = this.storage!.getItem(legacyKey);
          if (value) {
            // WEB-29: strip ONLY the leading '__'.
            //
            // This used to strip '__dl_', producing 'dl_anonymous_id' — but that
            // is the LOGICAL key callers pass to get(), not the key it reads.
            // get() prepends this.prefix ('dl_'), so the value actually lives at
            // 'dl_dl_anonymous_id'. The migration therefore wrote to an address
            // nothing reads AND then deleted the legacy key below, destroying
            // the visitor's id instead of migrating it: a silent visitor reset
            // and attribution loss for anyone still on the old prefix.
            //
            //   legacy real key : __dl_dl_anonymous_id
            //   current real key:   dl_dl_anonymous_id   ← strip '__'
            //   logical key     :      dl_anonymous_id   ← what get() is called with
            //
            // NOTE: the double 'dl_dl_' looks like a typo and is not. Renaming
            // the prefix would orphan every stored id across the install base.
            const actualKey = legacyKey.slice('__'.length); // '__dl_dl_anonymous_id' -> 'dl_dl_anonymous_id'

            // Only migrate if new key doesn't already exist (don't overwrite newer data)
            if (!this.storage!.getItem(actualKey)) {
              this.storage!.setItem(actualKey, value);
              migratedCount++;
            }

            // Remove legacy key after successful migration
            this.storage!.removeItem(legacyKey);
          }
        } catch (e) {
          console.warn(`[Datalyr Storage] Failed to migrate legacy key: ${legacyKey}`, e);
        }
      });

      if (migratedCount > 0) {
        console.log(`[Datalyr Storage] Migrated ${migratedCount} keys from legacy prefix`);
      }

    } catch (e) {
      console.warn('[Datalyr Storage] Error during legacy key migration:', e);
    }

    return migratedCount;
  }

  /**
   * Get encrypted value from storage (SEC-03 Fix)
   *
   * @param key - Storage key
   * @param defaultValue - Default value if not found
   * @returns Decrypted value
   */
  async getEncrypted(key: string, defaultValue: any = null): Promise<any> {
    const fullKey = this.prefix + key;

    try {
      // Get encrypted data
      let encryptedData: string | null = null;

      if (this.storage) {
        encryptedData = this.storage.getItem(fullKey);
      } else {
        encryptedData = this.memory.get(fullKey) || null;
      }

      if (!encryptedData) {
        return defaultValue;
      }

      // Decrypt
      const decrypted = await dataEncryption.decrypt(encryptedData);
      return decrypted;

    } catch (error) {
      console.warn('[Datalyr Storage] Failed to decrypt:', key, error);
      return defaultValue;
    }
  }

  /**
   * Set encrypted value in storage (SEC-03 Fix)
   *
   * FIXED (SEC-03): Now throws error if encryption fails instead of silent fallback
   *
   * @param key - Storage key
   * @param value - Value to encrypt and store
   * @returns Success boolean
   * @throws Error if encryption is not available or fails
   */
  async setEncrypted(key: string, value: any): Promise<boolean> {
    const fullKey = this.prefix + key;

    // FIXED: encrypt() now throws instead of returning null
    const encrypted = await dataEncryption.encrypt(value);

    // Store encrypted data
    if (this.storage) {
      this.storage.setItem(fullKey, encrypted);
      return true;
    } else {
      this.memory.set(fullKey, encrypted);
      return true;
    }
  }
}

// Cookie operations
class CookieStorage {
  private domain: string | 'auto';
  private maxAge: number;
  private sameSite: 'Strict' | 'Lax' | 'None';
  private secure: boolean | 'auto';

  constructor(options: {
    domain?: string | 'auto';
    maxAge?: number;
    sameSite?: 'Strict' | 'Lax' | 'None';
    secure?: boolean | 'auto';
  } = {}) {
    this.domain = options.domain || 'auto';
    this.maxAge = options.maxAge || 365;
    this.sameSite = options.sameSite || 'Lax';
    this.secure = options.secure || 'auto';
  }

  get(name: string): string | null {
    // FSR-56: parse document.cookie into name=value pairs and return the FIRST match.
    // The old `split('; ' + name + '=')` returned null whenever the same cookie name
    // appeared more than once (3+ parts) — extremely common for ad cookies set at both
    // the registrable domain and a subdomain (_fbp/_fbc/_ga), and producible by this SDK
    // itself (the __dl_visitor_id host-only fallback). That caused real _fbp/_fbc to be
    // ignored and re-synthesized, and the CC bridge cookie read to silently fail.
    // Browsers list the most specific (longer path / host) cookie first, so first wins.
    const cookieString = typeof document !== 'undefined' ? document.cookie : '';
    if (!cookieString) return null;
    for (const pair of cookieString.split(';')) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq) !== name) continue;
      const rawValue = trimmed.slice(eq + 1);
      if (!rawValue) return null;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        // Return raw value if decoding fails (backwards compatibility)
        return rawValue;
      }
    }
    return null;
  }

  set(name: string, value: string, days?: number): boolean {
    try {
      const maxAge = (days || this.maxAge) * 86400; // Convert to seconds
      const secure = this.secure === 'auto' 
        ? location.protocol === 'https:' 
        : this.secure;
      
      let domain = '';
      if (this.domain === 'auto') {
        // Auto-detect domain for cross-subdomain tracking
        domain = this.getAutoDomain();
      } else if (this.domain) {
        domain = `;domain=${this.domain}`;
      }

      const cookie = [
        `${name}=${encodeURIComponent(value)}`,
        `max-age=${maxAge}`,
        'path=/',
        `SameSite=${this.sameSite}`,
        secure ? 'Secure' : '',
        domain
      ].filter(Boolean).join(';');

      document.cookie = cookie;
      return true;
    } catch (e) {
      console.warn('[Datalyr] Failed to set cookie:', name, e);
      return false;
    }
  }

  remove(name: string): boolean {
    try {
      // Try to remove with various domain settings
      const domains = ['', location.hostname];
      
      // Add parent domain variations
      const parts = location.hostname.split('.');
      if (parts.length > 2) {
        domains.push(`.${parts.slice(-2).join('.')}`);
        domains.push(`.${location.hostname}`);
      }

      domains.forEach(domain => {
        const domainStr = domain ? `;domain=${domain}` : '';
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/${domainStr}`;
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Auto-detect the best domain for cross-subdomain tracking
   */
  private getAutoDomain(): string {
    const hostname = location.hostname;
    
    // Don't set domain for localhost or IP addresses
    if (hostname === 'localhost' || /^[\d.]+$/.test(hostname) || /^\[[\d:]+\]$/.test(hostname)) {
      return '';
    }

    // Try setting cookie at different domain levels to find the highest allowed
    const parts = hostname.split('.');
    
    // Start from the root domain and work up
    for (let i = parts.length - 2; i >= 0; i--) {
      const testDomain = '.' + parts.slice(i).join('.');
      const testName = '__dl_test_' + Math.random();
      
      // Try to set a test cookie
      document.cookie = `${testName}=1;domain=${testDomain};path=/`;
      
      // Check if it was set successfully
      if (document.cookie.indexOf(testName) !== -1) {
        // Remove test cookie
        document.cookie = `${testName}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;domain=${testDomain};path=/`;
        return `;domain=${testDomain}`;
      }
    }
    
    // If nothing worked, don't set domain (will default to current subdomain)
    return '';
  }
}

// Export singleton instances for storage.
// Guard the browser globals so importing the SDK on the server (SSR / Node)
// doesn't throw `window is not defined`. On the server these fall back to
// in-memory storage; real storage is wired when the module re-evaluates in the
// browser. (Without this, any static `import` of the SDK in a Next.js client
// component crashes server rendering.)
const browserLocalStorage =
  typeof window !== 'undefined' ? window.localStorage : undefined;
const browserSessionStorage =
  typeof window !== 'undefined' ? window.sessionStorage : undefined;

export const storage = new SafeStorage(browserLocalStorage);
export const sessionStorage = new SafeStorage(browserSessionStorage);

// Export cookie class (will be instantiated with config)
export { CookieStorage };

// Default cookie instance for backwards compatibility
export const cookies = new CookieStorage();