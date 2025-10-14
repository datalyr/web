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
  sessionTimeout?: number;              // Default: 30 minutes
  trackSessions?: boolean;              // Default: true
  
  // Attribution
  attributionWindow?: number;           // Default: 30 days
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
}

// Internal event payload structure
export interface IngestEventPayload {
  // Required identifiers
  workspaceId: string;
  workspace_id?: string;  // Alternative format
  
  // Identity fields (Mixpanel model)
  distinct_id: string;
  anonymous_id: string;
  user_id?: string;
  
  // Legacy compatibility
  visitor_id: string;
  visitorId: string;
  canonical_id: string;
  
  // Event data (both formats for compatibility)
  eventId: string;
  event_id?: string;
  eventName: string;
  event_name?: string;
  eventData: Record<string, any>;
  event_data?: Record<string, any>;
  
  // Session (both formats)
  sessionId: string;
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