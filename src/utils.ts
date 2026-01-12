/**
 * Utility Functions
 */

/**
 * Generate UUID v4
 */
export function generateUUID(): string {
  // Use crypto.randomUUID if available
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Get URL query parameter
 */
export function getQueryParam(name: string, search = window.location.search): string | null {
  try {
    if ('URLSearchParams' in window) {
      const params = new URLSearchParams(search);
      return params.get(name);
    }
  } catch {}
  
  // Manual fallback for older browsers
  const query = (search || '').replace(/^\?/, '').split('&');
  for (const part of query) {
    const [key, value = ''] = part.split('=');
    try {
      const decodedKey = decodeURIComponent((key || '').replace(/\+/g, ' '));
      if (decodedKey === name) {
        return decodeURIComponent((value || '').replace(/\+/g, ' '));
      }
    } catch {
      // Ignore bad encoding
    }
  }
  return null;
}

/**
 * Get all URL query parameters
 */
export function getAllQueryParams(search = window.location.search): Record<string, string> {
  const params: Record<string, string> = {};
  
  try {
    if ('URLSearchParams' in window) {
      const searchParams = new URLSearchParams(search);
      searchParams.forEach((value, key) => {
        params[key] = value;
      });
      return params;
    }
  } catch {}
  
  // Manual fallback
  const query = (search || '').replace(/^\?/, '').split('&');
  for (const part of query) {
    const [key, value = ''] = part.split('=');
    try {
      const decodedKey = decodeURIComponent((key || '').replace(/\+/g, ' '));
      const decodedValue = decodeURIComponent((value || '').replace(/\+/g, ' '));
      if (decodedKey) {
        params[decodedKey] = decodedValue;
      }
    } catch {
      // Ignore bad encoding
    }
  }
  
  return params;
}

/**
 * Sanitize event data (remove sensitive keys, DOM elements, functions)
 */
export function sanitizeEventData(data: any, maxDepth = 5, currentDepth = 0): any {
  if (currentDepth >= maxDepth) return '[Max depth reached]';
  if (data === null || data === undefined) return data;
  
  // Remove DOM elements and functions
  if (
    (typeof Element !== 'undefined' && data instanceof Element) ||
    (typeof Document !== 'undefined' && data instanceof Document) ||
    typeof data === 'function'
  ) {
    return '[Removed]';
  }
  
  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => sanitizeEventData(item, maxDepth, currentDepth + 1));
  }
  
  // Handle objects
  if (typeof data === 'object') {
    const sanitized: Record<string, any> = {};
    const sensitiveKeys = /pass|pwd|token|secret|auth|bearer|session|cookie|signature|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token/i;
    
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        // Skip sensitive keys
        if (sensitiveKeys.test(key)) {
          continue;
        }
        
        // Sanitize value recursively
        sanitized[key] = sanitizeEventData(data[key], maxDepth, currentDepth + 1);
      }
    }
    
    return sanitized;
  }
  
  // Handle strings
  if (typeof data === 'string') {
    // Truncate very long strings
    if (data.length > 1000) {
      return data.slice(0, 1000) + '...[truncated]';
    }
    
    // Remove potential JWT tokens or API keys
    if (data.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/) || // JWT
        data.match(/^[a-f0-9]{32,}$/i)) { // Hex tokens
      return '[Redacted]';
    }
    
    return data;
  }
  
  return data;
}

/**
 * Deep merge objects
 */
export function deepMerge(target: any, ...sources: any[]): any {
  if (!sources.length) return target;
  const source = sources.shift();
  
  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  
  return deepMerge(target, ...sources);
}

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  
  return function(...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
export function calculateRetryDelay(attempt: number, baseDelay = 1000): number {
  const maxDelay = 30000; // 30 seconds max
  const jitter = Math.random() * 0.1; // 10% jitter
  return Math.min(baseDelay * Math.pow(2, attempt) * (1 + jitter), maxDelay);
}

/**
 * Check if browser Do Not Track is enabled
 */
export function isDoNotTrackEnabled(): boolean {
  return navigator.doNotTrack === '1' || 
         (window as any).doNotTrack === '1' ||
         navigator.doNotTrack === 'yes';
}

/**
 * Check if Global Privacy Control is enabled
 */
export function isGlobalPrivacyControlEnabled(): boolean {
  return (navigator as any).globalPrivacyControl === true ||
         (window as any).globalPrivacyControl === true;
}

/**
 * Get root domain for cross-subdomain tracking
 */
export function getRootDomain(): string {
  const hostname = window.location.hostname;

  // Handle localhost and IP addresses
  if (hostname === 'localhost' ||
      hostname.match(/^[0-9]{1,3}\./) || // IPv4
      hostname.match(/^\[?[0-9a-fA-F:]+\]?$/)) { // IPv6
    return hostname;
  }

  // Get root domain (last two parts: example.com)
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    // Handle .co.uk, .com.au, etc
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];

    // Common two-part TLDs (country-specific domains)
    // Note: The CookieStorage.getAutoDomain() probe method handles unknown TLDs dynamically,
    // but this list provides faster resolution for known patterns
    const twoPartTlds = [
      // United Kingdom
      'co.uk', 'org.uk', 'net.uk', 'ac.uk', 'gov.uk', 'me.uk',
      // Australia
      'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
      // New Zealand
      'co.nz', 'net.nz', 'org.nz', 'govt.nz',
      // Japan
      'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
      // India
      'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
      // South Africa
      'co.za', 'net.za', 'org.za', 'gov.za',
      // Brazil
      'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
      // South Korea
      'co.kr', 'ne.kr', 'or.kr', 'go.kr', 'ac.kr',
      // China
      'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
      // Other Asia-Pacific
      'co.id', 'co.th', 'com.sg', 'com.my', 'com.ph', 'com.vn',
      'com.tw', 'com.hk',
      // Latin America
      'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.cl',
      // Europe
      'co.il', 'co.at', 'co.hu', 'co.pl'
    ];
    const lastTwo = `${sld}.${tld}`;

    if (twoPartTlds.includes(lastTwo) && parts.length >= 3) {
      return '.' + parts.slice(-3).join('.');
    }

    return '.' + parts.slice(-2).join('.');
  }

  return hostname;
}

/**
 * Get referrer data
 */
export function getReferrerData(): Record<string, any> {
  const referrer = document.referrer;
  if (!referrer) return {};
  
  try {
    const url = new URL(referrer);
    return {
      referrer,
      referrer_host: url.hostname,
      referrer_path: url.pathname,
      referrer_search: url.search,
      referrer_source: detectReferrerSource(url.hostname)
    };
  } catch {
    return { referrer };
  }
}

/**
 * Detect referrer source
 */
function detectReferrerSource(hostname: string): string {
  const sources: Record<string, string[]> = {
    google: ['google.com', 'google.'],
    facebook: ['facebook.com', 'fb.com'],
    twitter: ['twitter.com', 't.co', 'x.com'],
    linkedin: ['linkedin.com', 'lnkd.in'],
    instagram: ['instagram.com'],
    youtube: ['youtube.com', 'youtu.be'],
    tiktok: ['tiktok.com'],
    reddit: ['reddit.com'],
    pinterest: ['pinterest.com'],
    bing: ['bing.com'],
    yahoo: ['yahoo.com'],
    duckduckgo: ['duckduckgo.com'],
    baidu: ['baidu.com']
  };
  
  for (const [source, domains] of Object.entries(sources)) {
    if (domains.some(domain => hostname.includes(domain))) {
      return source;
    }
  }
  
  return 'other';
}