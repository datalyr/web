/**
 * Utility Functions
 */

/**
 * SHA-256 hex digest aligned with the worker's CAPI hashing (cloudflare/
 * postback/core/utils.js `sha256()`). Always lowercases + trims the input
 * before hashing — Meta's matching requires byte-for-byte identical hashes
 * on the Pixel side and the CAPI server side, and the worker uniformly
 * normalizes everything it hashes (em, ph, fn, ln, external_id, etc).
 *
 * Pixel-side hashes that don't match CAPI hashes silently fail to dedupe,
 * which is why this helper does the normalization for callers — easy to
 * forget, hard to debug after release. Returns null when Web Crypto isn't
 * available (very old browsers, non-secure contexts) so callers can
 * gracefully skip advanced matching rather than throwing.
 */
export async function sha256Hex(input: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  if (!input) return null;
  try {
    const bytes = new TextEncoder().encode(input.toLowerCase().trim());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

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

// FSR-57: credential detection that matches whole TOKENS (after splitting a key on
// camelCase + separators), not substrings. The old substring regex deleted innocent
// keys — `author`/`authority` (contains 'auth'), `passenger_count`/`passport_number`
// (contains 'pass'), `session_type`/`cookie_consent` — silently dropping customer event
// properties. 'session' and 'cookie' are intentionally absent: they're not credentials.
// Single words that are unambiguous as whole tokens:
const SENSITIVE_KEY_WORDS = new Set([
  'pass', 'password', 'passwd', 'pwd',
  'secret', 'token', 'auth', 'authorization',
  'bearer', 'signature', 'cvv', 'cvc', 'ssn'
]);
// Compound credentials that tokenize into innocent-looking parts (api_key → api+key)
// — matched against the separator-stripped key so api_key / apiKey / access_token all hit.
const SENSITIVE_KEY_COMPOUNDS = [
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'publickey',
  'accesstoken', 'refreshtoken', 'idtoken', 'clientsecret',
  'creditcard', 'cardnumber'
];

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._\-]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean);
  if (words.some(w => SENSITIVE_KEY_WORDS.has(w))) return true;
  const normalized = key.toLowerCase().replace(/[\s._\-]+/g, '');
  return SENSITIVE_KEY_COMPOUNDS.some(c => normalized.includes(c));
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

    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        // Skip sensitive keys (whole-token match — see SENSITIVE_KEY_WORDS)
        if (isSensitiveKey(key)) {
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

    // FSR-57: redact only UNAMBIGUOUS JWTs — base64url '{"...' header always starts with
    // 'eyJ'. The old rules redacted ANY 3-dot-segment string ('www.google.com' → so every
    // 3-label referrer_host became '[Redacted]'; '1.7.1' semver too) and ANY 32+-char hex
    // string (md5/order IDs, pre-hashed emails, and — critically — 32-hex customer user
    // IDs on the $alias path, which silently wrote user_id='[Redacted]' into
    // visitor_user_links, collapsing those users). Credential-bearing KEYS are already
    // dropped above, so the bare-hex value heuristic was net-negative and is removed.
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data)) { // JWT
      return '[Redacted]';
    }

    return data;
  }

  return data;
}

// 9.A.4: query-param NAMES whose VALUES are secrets/PII — password-reset tokens,
// OAuth codes, magic-link sessions, emails/phones prefilled into URLs. Events ship
// `url` / `referrer` / `landingPage` with the FULL query string (sanitizeEventData
// only strips property KEYS, not URL param values), so /reset?token=…&email=… leaked
// verbatim into events and onward to ad platforms. Matched case-insensitively.
const REDACTED_URL_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'authorization',
  'password', 'pass', 'pwd', 'secret', 'api_key', 'apikey', 'key',
  'session', 'session_id', 'sid', 'email', 'e', 'phone', 'tel',
  'signature', 'sig', 'otp', 'reset', 'hash'
]);

// BATCH-2(e): `code` is CONDITIONAL, not in the always-redact set above. An OAuth
// authorization code (account-takeover-grade if it leaks to ad platforms) ALWAYS travels
// with an OAuth-flow marker in the same query/fragment — the response carries `code`+`state`
// (+`scope`/`session_state`/`iss`), the authorize request carries `client_id`/`redirect_uri`/
// `response_type`/`code_challenge`. A coupon/referral/product code (`?code=SUMMER20`) — a real
// attribution signal for the DTC/Shopify ICP — never does. So we redact `code` ONLY when a
// marker co-occurs in the same k=v string, preserving marketing codes. (A bare `code=` with no
// marker is syntactically indistinguishable from a coupon code and is kept; state-less OAuth
// flows are rare and CSRF-unsafe.) Markers are deliberately OAuth-specific to avoid redacting
// legitimate codes — `prompt`/`authuser` are excluded as too generic.
const OAUTH_CODE_CONTEXT_MARKERS = new Set([
  'state', 'client_id', 'redirect_uri', 'response_type', 'grant_type',
  'code_challenge', 'session_state', 'scope', 'iss',
  // Token family: the presence of any bearer/OAuth token means a bare `code` in the same
  // string is almost certainly an auth code, not a coupon — a marketing URL never carries
  // these. (These values are independently redacted too; this only governs `code`.)
  'access_token', 'id_token', 'refresh_token', 'token'
]);

const REDACTED_URL_VALUE = '__redacted__';

// Redact denylisted keys in one `k=v&k=v` string (query OR fragment). Returns the
// re-encoded string and whether anything was rewritten (so the caller can preserve the
// exact original bytes when nothing matched).
function redactKvPairs(s: string): { out: string; mutated: boolean } {
  const params = new URLSearchParams(s);
  let mutated = false;
  const keysLower = Array.from(new Set(params.keys())).map(k => k.toLowerCase());
  // `code` co-occurrence check (BATCH-2e) — evaluated per-string, since an OAuth flow puts
  // `code` and its marker in the SAME query (or the SAME fragment).
  const hasOAuthMarker = keysLower.some(k => OAUTH_CODE_CONTEXT_MARKERS.has(k));
  // Snapshot the keys first — set() collapses duplicate keys mid-iteration.
  for (const key of Array.from(new Set(params.keys()))) {
    const lower = key.toLowerCase();
    const sensitive = lower === 'code'
      ? hasOAuthMarker
      : REDACTED_URL_PARAMS.has(lower);
    if (sensitive) {
      params.set(key, REDACTED_URL_VALUE);
      mutated = true;
    }
  }
  return { out: params.toString(), mutated };
}

/**
 * Redact secret/PII param VALUES in a URL (9.A.4). The param NAME is kept
 * (value → `__redacted__`) so funnel steps that match on the param's presence still
 * work; every other param — click IDs (fbclid/gclid/…) and utm_* — survives untouched.
 * Both the query string AND a k=v fragment are rewritten: TR-04 — OAuth-implicit /
 * Supabase magic links carry the session in the FRAGMENT (`/welcome#access_token=eyJ…`),
 * with no query string at all; the old code returned early on a missing `?` and reattached
 * the fragment verbatim, leaking the full JWT into `url` / `landingPage` / `dl_first_touch`
 * (90d) and onward to ad platforms. Non-k=v fragments (`#section`, `#/spa-route`) keep their
 * shape. Returns the input unchanged when nothing sensitive matched or on any parse
 * failure — redaction must never break tracking.
 */
export function redactUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;
  const hashStart = url.indexOf('#');
  const qIdx = url.indexOf('?');
  // A query string exists only when '?' appears BEFORE the fragment — a '?' after '#' is
  // part of the fragment per the URL grammar (e.g. a SPA hash-route `#/reset?token=…`).
  const queryStart = (qIdx !== -1 && (hashStart === -1 || qIdx < hashStart)) ? qIdx : -1;
  if (queryStart === -1 && hashStart === -1) return url; // nothing to redact
  try {
    const base = url.slice(0, queryStart !== -1 ? queryStart : (hashStart !== -1 ? hashStart : url.length));
    const query = queryStart === -1 ? '' : url.slice(queryStart + 1, hashStart === -1 ? url.length : hashStart);
    const rawFragment = hashStart === -1 ? '' : url.slice(hashStart + 1);

    let mutated = false;

    let queryOut = query;
    if (query) {
      const r = redactKvPairs(query);
      if (r.mutated) { queryOut = r.out; mutated = true; }
    }

    // TR-04: redact the fragment when it carries k=v pairs. Two shapes: a pure implicit-flow
    // fragment (`#access_token=…&refresh_token=…`) and a SPA hash-route with its own query
    // (`#/reset?access_token=…`). Leave non-k=v fragments (`#section`, `#/route`) untouched.
    let fragmentOut = rawFragment;
    if (rawFragment) {
      const fragQ = rawFragment.indexOf('?');
      if (fragQ !== -1) {
        const r = redactKvPairs(rawFragment.slice(fragQ + 1));
        if (r.mutated) { fragmentOut = rawFragment.slice(0, fragQ + 1) + r.out; mutated = true; }
      } else if (/[\w-]+=/.test(rawFragment)) {
        const r = redactKvPairs(rawFragment);
        if (r.mutated) { fragmentOut = r.out; mutated = true; }
      }
    }

    if (!mutated) return url; // nothing sensitive matched → ship the exact original bytes

    return base
      + (queryStart === -1 ? '' : '?' + queryOut)
      + (hashStart === -1 ? '' : '#' + fragmentOut);
  } catch {
    return url; // malformed URL → ship as-is rather than drop/break the event
  }
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

// Common two-part TLDs (country-specific registries) where the registrable domain is
// the last THREE labels (e.g. shop.example.co.uk → example.co.uk). Not a full public
// suffix list, but covers the markets we see; CookieStorage.getAutoDomain() probes
// dynamically for the rest.
const TWO_PART_TLDS = new Set([
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
]);

/**
 * Registrable domain (eTLD+1) for a hostname, honoring two-part ccTLDs.
 *   shop.example.co.uk → example.co.uk
 *   www.example.com    → example.com
 *   localhost / IPs    → returned unchanged
 * Returns a bare host (no leading dot) — getRootDomain() adds the cookie-domain dot.
 * (FSR-47: same-site referrer classification must use this, not naive last-two-labels.)
 */
export function getRegistrableDomain(hostname: string): string {
  if (!hostname) return hostname;
  const lower = hostname.toLowerCase();

  // Handle localhost and IP addresses
  if (lower === 'localhost' ||
      /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(lower) || // IPv4
      /^\[?[0-9a-fA-F:]+\]?$/.test(lower)) { // IPv6
    return hostname;
  }

  const parts = lower.split('.');
  if (parts.length < 2) return hostname;

  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * Get root domain for cross-subdomain tracking (cookie-domain form, with leading dot).
 */
export function getRootDomain(): string {
  const hostname = window.location.hostname;

  // Handle localhost and IP addresses — never set a cookie domain for these.
  if (hostname === 'localhost' ||
      hostname.match(/^[0-9]{1,3}\./) || // IPv4
      hostname.match(/^\[?[0-9a-fA-F:]+\]?$/)) { // IPv6
    return hostname;
  }

  const parts = hostname.split('.');
  if (parts.length < 2) return hostname;

  return '.' + getRegistrableDomain(hostname);
}

/**
 * Get referrer data
 */
export function getReferrerData(): Record<string, any> {
  const referrer = document.referrer;
  if (!referrer) return {};

  try {
    const url = new URL(referrer);
    // 9.A.4: the referrer can be our own /reset?token=… or an OAuth callback —
    // redact secret/PII param values before they're stamped onto the event.
    return {
      referrer: redactUrl(referrer),
      referrer_host: url.hostname,
      referrer_path: url.pathname,
      referrer_search: redactUrl(url.search),
      referrer_source: detectReferrerSource(url.hostname)
    };
  } catch {
    return { referrer: redactUrl(referrer) };
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