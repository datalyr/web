/**
 * Datalyr Web SDK - Type Definitions
 */

export interface DatalyrConfig {
  // Required
  workspaceId: string;
  
  // Optional
  endpoint?: string;                    // Default: 'https://ingest.datalyr.com'
  debug?: boolean;                      // Default: false
  
  // Batching
  batchSize?: number;                   // Default: 10
  flushInterval?: number;               // Default: 5000ms
  flushAt?: number;                     // Default: 10 (events)
  
  // Critical events (bypass batching)
  criticalEvents?: string[];           // Default: ['purchase', 'signup', 'subscribe', 'lead', 'conversion']
  highPriorityEvents?: string[];       // Default: ['add_to_cart', 'begin_checkout', 'view_item', 'search']
  
  // Session
  sessionTimeout?: number;              // Default: 60 minutes (increased from 30 for OAuth flows)
  trackSessions?: boolean;              // Default: true
  
  // Attribution
  attributionWindow?: number;           // Default: 90 days (increased from 30 for B2B sales cycles)
  trackedParams?: string[];             // Additional URL params to track
  
  // Privacy
  respectDoNotTrack?: boolean;          // Default: false
  respectGlobalPrivacyControl?: boolean; // Default: true
  privacyMode?: 'standard' | 'strict';  // Default: 'standard'
  
  // Storage
  cookieDomain?: string | 'auto';       // Default: 'auto'
  cookieExpires?: number;               // Default: 365 days
  secureCookie?: boolean | 'auto';      // Default: 'auto'
  sameSite?: 'Strict' | 'Lax' | 'None'; // Default: 'Lax'
  cookiePrefix?: string;                // Default: '__dl_'
  
  // Performance
  enablePerformanceTracking?: boolean;  // Default: true
  enableFingerprinting?: boolean;       // Default: true (standard mode only)
  
  // Retry & Network
  maxRetries?: number;                  // Default: 5
  retryDelay?: number;                  // Default: 1000ms
  maxOfflineQueueSize?: number;         // Default: 100
  
  // SPA
  trackSPA?: boolean;                   // Default: true
  trackPageViews?: boolean;             // Default: true (initial page view)
  
  // Container Scripts
  enableContainer?: boolean;             // Default: true - Load third-party scripts

  // Auto-Identify (opt-in feature for convenience)
  autoIdentify?: boolean;                // Default: false - Set true to automatically identify users
  autoIdentifyForms?: boolean;           // Default: true - Capture email from forms (when autoIdentify enabled)
  autoIdentifyAPI?: boolean;             // Default: true - Capture email from API requests/responses (when autoIdentify enabled)
  autoIdentifyShopify?: boolean;         // Default: true - Capture email from Shopify endpoints (when autoIdentify enabled)
  autoIdentifyTrustedDomains?: string[]; // Default: [] - Additional domains to trust for API capture

  // Fallback endpoints for resilience
  fallbackEndpoints?: string[];         // Additional endpoints to try

  // Plugins
  plugins?: DatalyrPlugin[];
}

export interface EventProperties {
  [key: string]: any;
  
  // Special properties (automatically captured if present)
  value?: number;
  currency?: string;
  
  // E-commerce
  product_id?: string;
  product_name?: string;
  category?: string;
  quantity?: number;
  price?: number;
  
  // Attribution (captured from URL if present)
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  
  // Click IDs (captured from URL if present)
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  msclkid?: string;
  twclid?: string;
  li_fat_id?: string;
}

export interface UserTraits {
  [key: string]: any;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  avatar?: string;
  createdAt?: string | Date;
  plan?: string;
}

export interface PageProperties {
  title?: string;
  url?: string;
  path?: string;
  referrer?: string;
  search?: string;
  [key: string]: any;
}

export interface SessionData {
  id: string;
  startTime: number;
  lastActivity: number;
  pageViews: number;
  events: number;
  duration: number;
  isActive: boolean;
}

export interface Attribution {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  term?: string | null;
  content?: string | null;
  clickId?: string | null;
  clickIdType?: string | null;  // fbclid, gclid, etc.
  referrer?: string | null;
  referrerHost?: string | null;
  landingPage?: string | null;
  landingPath?: string | null;
  timestamp?: number;
  [key: string]: any;  // For custom tracked params
}

export interface TouchPoint {
  timestamp: number;
  source?: string;
  medium?: string;
  campaign?: string;
  sessionId: string;
}

export interface ConsentConfig {
  analytics?: boolean;
  marketing?: boolean;
  preferences?: boolean;
  sale?: boolean;
}

export interface DatalyrPlugin {
  name: string;
  initialize(datalyr: any): void;
  page?(properties: PageProperties): void;
  track?(eventName: string, properties: EventProperties): void;
  identify?(userId: string, traits: UserTraits): void;
  loaded?(): void;
}

// Fingerprint data collected from browser
// PRIVACY: Minimal data collection only (matches browser tag approach)
export interface FingerprintData {
  // Minimal fingerprinting for attribution
  timezone?: string | null;
  language?: string | null;
  screen_bucket?: string | null;  // Coarse screen size (rounded to 100px)
  dnt?: boolean | null;            // Do Not Track / Global Privacy Control
  userAgent?: string | null;       // CRITICAL: For device/browser/OS detection
  userAgentData?: {                // Modern User-Agent Client Hints API
    brands: Array<{ brand: string; version: string }>;
    mobile: boolean;
    platform: string | null;
  } | null;
}

// Internal event payload structure
// NOTE: Uses snake_case to match backend API and production tracking script
export interface IngestEventPayload {
  // Required identifiers (snake_case only)
  workspace_id: string;

  // Identity fields (Mixpanel model - snake_case only)
  distinct_id: string;
  anonymous_id: string;
  user_id?: string;

  // Legacy compatibility (snake_case only)
  visitor_id: string;
  canonical_id: string;

  // Event data (snake_case only - no duplication)
  event_id: string;
  event_name: string;
  event_data: Record<string, any>;

  // Session (snake_case only)
  session_id: string;
  
  // Attribution (will be in eventData but also top-level for queries)
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  
  // Fingerprint
  fingerprintData?: FingerprintData;
  fingerprint_data?: FingerprintData;
  
  // Source
  source: 'web';
  
  // Identity resolution
  resolution_method: 'browser_sdk';
  resolution_confidence: 1.0;
  
  // Timestamps
  timestamp?: string;
  received_at?: string;
  
  // SDK info
  sdk_version?: string;
  sdk_name?: string;
}

export interface IngestBatchPayload {
  events: IngestEventPayload[];
  batchId: string;
  timestamp: string;
}

// Network status
export interface NetworkStatus {
  isOnline: boolean;
  lastOfflineAt: number | null;
  lastOnlineAt: number | null;
}

// Error tracking
export interface ErrorInfo {
  message: string;
  stack?: string;
  context?: any;
  timestamp: string;
  url: string;
}

// Performance metrics
export interface PerformanceMetrics {
  pageLoadTime?: number;
  domReadyTime?: number;
  firstByteTime?: number;
  dnsTime?: number;
  tcpTime?: number;
  requestTime?: number;
  timeOnPage?: number;
  scrollDepth?: number;
  memoryUsed?: number;
  protocol?: string;
}