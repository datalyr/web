/**
 * Storage Module
 * Safe storage wrapper with fallbacks for Safari private mode
 */

interface StorageWrapper {
  get(key: string, defaultValue?: any): any;
  set(key: string, value: any): boolean;
  remove(key: string): boolean;
  keys(): string[];
}

class SafeStorage implements StorageWrapper {
  private storage: Storage | null;
  private memory: Map<string, string> = new Map();
  private prefix = '__dl_';

  constructor(storage: Storage) {
    // Test if storage is available
    try {
      const testKey = '__dl_test__' + Math.random();
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