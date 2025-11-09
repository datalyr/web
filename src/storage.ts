/**
 * Storage Module
 * Safe storage wrapper with fallbacks for Safari private mode
 * SEC-03 Fix: Added encryption support for PII data
 */

import { dataEncryption } from './encryption';

interface StorageWrapper {
  get(key: string, defaultValue?: any): any;
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

  constructor(storage: Storage) {
    // Test if storage is available
    try {
      const testKey = 'dl_test__' + Math.random();
      storage.setItem(testKey, '1');
      storage.removeItem(testKey);
      this.storage = storage;
    } catch {
      // Storage not available (Safari private mode, etc.)
      this.storage = null;
      console.warn('[Datalyr] Storage not available, using memory fallback');
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
            // Extract the actual key name (remove '__dl_' prefix, keep 'dl_' part)
            const actualKey = legacyKey.slice('__dl_'.length); // e.g., '__dl_dl_anonymous_id' -> 'dl_anonymous_id'

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
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) {
      const rawValue = parts.pop()?.split(';').shift() || null;
      if (rawValue) {
        try {
          return decodeURIComponent(rawValue);
        } catch {
          // Return raw value if decoding fails (backwards compatibility)
          return rawValue;
        }
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

// Export singleton instances for storage
export const storage = new SafeStorage(window.localStorage);
export const sessionStorage = new SafeStorage(window.sessionStorage);

// Export cookie class (will be instantiated with config)
export { CookieStorage };

// Default cookie instance for backwards compatibility
export const cookies = new CookieStorage();