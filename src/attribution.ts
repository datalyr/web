/**
 * Attribution Tracking Module
 * Handles UTM parameters, click IDs, and customer journey
 */

import { storage, cookies } from './storage';
import { getAllQueryParams } from './utils';
import type { Attribution, TouchPoint } from './types';

export class AttributionManager {
  private attributionWindow: number;
  private trackedParams: string[];
  private queryParamsCache: Record<string, string> | null = null;
  private UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  // Updated to match dl.js - includes ALL ad platform click IDs
  private CLICK_IDS = [
    'fbclid',     // Facebook/Meta
    'gclid',      // Google Ads
    'gbraid',     // Google Ads (iOS)
    'wbraid',     // Google Ads (web)
    'ttclid',     // TikTok
    'msclkid',    // Microsoft/Bing
    'twclid',     // Twitter/X
    'li_fat_id',  // LinkedIn
    'sclid',      // Snapchat
    'dclid',      // Google Display/DoubleClick
    'epik',       // Pinterest
    'rdt_cid',    // Reddit
    'obclid',     // Outbrain
    'irclid',     // Impact Radius
    'ko_click_id' // Klaviyo
  ];
  // Default tracked params matching dl.js
  private DEFAULT_TRACKED_PARAMS = [
    'lyr',        // Datalyr partner tracking
    'ref',        // Generic referral
    'source',     // Generic source (non-UTM)
    'campaign',   // Generic campaign (non-UTM)
    'medium',     // Generic medium (non-UTM)
    'gad_source'  // Google Ads source parameter
  ];

  constructor(options: {
    attributionWindow?: number;
    trackedParams?: string[];
  } = {}) {
    this.attributionWindow = options.attributionWindow || 90 * 24 * 60 * 60 * 1000; // 90 days (increased from 30 for B2B sales cycles)
    // Merge default tracked params with user-provided ones
    this.trackedParams = [...this.DEFAULT_TRACKED_PARAMS, ...(options.trackedParams || [])];
  }

  /**
   * Clear query params cache (called on page navigation)
   * FIXED: Prevents stale attribution data on SPA navigation
   */
  clearCache(): void {
    this.queryParamsCache = null;
  }

  /**
   * Capture current attribution from URL
   */
  captureAttribution(): Attribution {
    // Cache query params to avoid multiple parses within same page load (Issue #3)
    // NOTE: Cache is cleared on page navigation to prevent stale data
    const params = this.queryParamsCache || getAllQueryParams();
    if (!this.queryParamsCache) {
      this.queryParamsCache = params;
    }

    const attribution: Attribution = {
      timestamp: Date.now()
    };

    // Capture UTM parameters
    for (const utm of this.UTM_PARAMS) {
      const value = params[utm];
      if (value) {
        const key = utm.replace('utm_', '') as keyof Attribution;
        attribution[key] = value;
      }
    }

    // Capture click IDs
    for (const clickId of this.CLICK_IDS) {
      const value = params[clickId];
      if (value) {
        attribution.clickId = value;
        attribution.clickIdType = clickId;
        break; // Use first found click ID
      }
    }

    // Capture custom tracked parameters
    for (const param of this.trackedParams) {
      const value = params[param];
      if (value) {
        attribution[param] = value;
      }
    }

    // Capture referrer
    if (document.referrer) {
      attribution.referrer = document.referrer;
      attribution.referrerHost = this.extractHostname(document.referrer);
    }

    // Capture landing page
    attribution.landingPage = window.location.href;
    attribution.landingPath = window.location.pathname;

    // Determine source if not explicitly set
    if (!attribution.source) {
      attribution.source = this.determineSource(attribution);
    }

    // Determine medium if not explicitly set
    if (!attribution.medium) {
      attribution.medium = this.determineMedium(attribution);
    }

    return attribution;
  }

  /**
   * Store first touch attribution with 90-day expiration
   *
   * FIXED (DATA-01): Removed paid priority logic that was corrupting first-touch attribution.
   * First-touch is now IMMUTABLE except for expiration - this ensures accurate revenue attribution.
   */
  storeFirstTouch(attribution: Attribution): void {
    const existing = storage.get('dl_first_touch');

    let shouldStore = false;

    if (!existing) {
      // No existing attribution - store first touch
      shouldStore = true;
    } else if (existing.expires_at && Date.now() >= existing.expires_at) {
      // Existing attribution expired - replace it
      shouldStore = true;
    }
    // REMOVED PAID PRIORITY LOGIC - First-touch must be immutable for accurate attribution
    // If there's existing valid attribution, keep it (true first-touch strategy)

    if (shouldStore) {
      storage.set('dl_first_touch', {
        ...attribution,
        captured_at: Date.now(),
        expires_at: Date.now() + this.attributionWindow
      });
    }
  }

  /**
   * Get first touch attribution
   * Checks expiry and removes if expired (Issue #4)
   */
  getFirstTouch(): Attribution | null {
    const data = storage.get('dl_first_touch');
    if (data && data.expires_at && Date.now() >= data.expires_at) {
      storage.remove('dl_first_touch');
      return null;
    }
    return data;
  }

  /**
   * Store last touch attribution with 90-day expiration
   */
  storeLastTouch(attribution: Attribution): void {
    storage.set('dl_last_touch', {
      ...attribution,
      captured_at: Date.now(),
      expires_at: Date.now() + this.attributionWindow
    });
  }

  /**
   * Get last touch attribution
   * Checks expiry and removes if expired (Issue #4)
   */
  getLastTouch(): Attribution | null {
    const data = storage.get('dl_last_touch');
    if (data && data.expires_at && Date.now() >= data.expires_at) {
      storage.remove('dl_last_touch');
      return null;
    }
    return data;
  }

  /**
   * Add touchpoint to customer journey
   */
  addTouchpoint(sessionId: string, attribution: Attribution): void {
    const journey = this.getJourney();
    
    const touchpoint: TouchPoint = {
      timestamp: Date.now(),
      sessionId,
      source: attribution.source || undefined,
      medium: attribution.medium || undefined,
      campaign: attribution.campaign || undefined
    };

    journey.push(touchpoint);

    // Keep last 30 touchpoints
    if (journey.length > 30) {
      journey.shift();
    }

    storage.set('dl_journey', journey);
  }

  /**
   * Get customer journey
   */
  getJourney(): TouchPoint[] {
    return storage.get('dl_journey', []);
  }

  /**
   * Capture advertising platform cookies
   */
  private captureAdCookies(): Record<string, string | null> {
    const adCookies: Record<string, string | null> = {};
    
    // Facebook/Meta cookies
    adCookies._fbp = cookies.get('_fbp');
    adCookies._fbc = cookies.get('_fbc');
    
    // Google Ads cookies
    adCookies._gcl_aw = cookies.get('_gcl_aw');
    adCookies._gcl_dc = cookies.get('_gcl_dc');
    adCookies._gcl_gb = cookies.get('_gcl_gb');
    adCookies._gcl_ha = cookies.get('_gcl_ha');
    adCookies._gac = cookies.get('_gac');
    
    // Google Analytics cookies
    adCookies._ga = cookies.get('_ga');
    adCookies._gid = cookies.get('_gid');
    
    // TikTok cookies
    adCookies._ttp = cookies.get('_ttp');
    adCookies._ttc = cookies.get('_ttc');
    
    // Generate _fbp if missing (Facebook browser ID)
    if (!adCookies._fbp && (this.hasClickId('fbclid') || adCookies._fbc)) {
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substring(2, 15);
      adCookies._fbp = `fb.1.${timestamp}.${randomId}`;
      // Optionally set the cookie for future use
      cookies.set('_fbp', adCookies._fbp, 90);
    }
    
    // Generate _fbc if we have fbclid but no _fbc
    const fbclid = this.getCurrentFbclid();
    if (fbclid && !adCookies._fbc) {
      const timestamp = Math.floor(Date.now() / 1000);
      adCookies._fbc = `fb.1.${timestamp}.${fbclid}`;
      // Optionally set the cookie for future use
      cookies.set('_fbc', adCookies._fbc, 90);
    }
    
    // Filter out null values for cleaner data
    return Object.fromEntries(
      Object.entries(adCookies).filter(([_, value]) => value !== null)
    );
  }

  /**
   * Check if we have a specific click ID in current params
   * Uses cached params to avoid multiple URL parses (Issue #3)
   */
  private hasClickId(clickIdType: string): boolean {
    const params = this.queryParamsCache || getAllQueryParams();
    return !!params[clickIdType];
  }

  /**
   * Get current fbclid from URL if present
   * Uses cached params to avoid multiple URL parses (Issue #3)
   */
  private getCurrentFbclid(): string | null {
    const params = this.queryParamsCache || getAllQueryParams();
    return params.fbclid || null;
  }

  /**
   * Get attribution data for event
   */
  getAttributionData(): Record<string, any> {
    const firstTouch = this.getFirstTouch();
    const lastTouch = this.getLastTouch();
    const journey = this.getJourney();
    let current = this.captureAttribution();

    // CRITICAL FIX: If current session has no attribution (direct/organic),
    // fallback to persistent attribution from localStorage (90-day window)
    const hasCurrentAttribution = !!(
      current.source || current.medium || current.clickId || current.campaign
    );

    if (!hasCurrentAttribution && firstTouch) {
      // Check if persistent attribution is still valid
      if (!firstTouch.expires_at || Date.now() < firstTouch.expires_at) {
        // Use persistent attribution but keep current page context
        current = {
          ...firstTouch,
          referrer: current.referrer,
          referrerHost: current.referrerHost,
          landingPage: current.landingPage,
          landingPath: current.landingPath
        };
      }
    }

    // Capture advertising cookies automatically
    const adCookies = this.captureAdCookies();

    // Update first/last touch if needed
    if (!firstTouch && Object.keys(current).length > 1) {
      this.storeFirstTouch(current);
    }
    if (Object.keys(current).length > 1) {
      this.storeLastTouch(current);
    }

    return {
      // Current attribution
      ...current,
      
      // Advertising platform cookies
      ...adCookies,
      
      // First touch (with snake_case aliases)
      first_touch_source: firstTouch?.source,
      first_touch_medium: firstTouch?.medium,
      first_touch_campaign: firstTouch?.campaign,
      first_touch_timestamp: firstTouch?.timestamp,
      firstTouchSource: firstTouch?.source,
      firstTouchMedium: firstTouch?.medium,
      firstTouchCampaign: firstTouch?.campaign,
      
      // Last touch (with snake_case aliases)
      last_touch_source: lastTouch?.source,
      last_touch_medium: lastTouch?.medium,
      last_touch_campaign: lastTouch?.campaign,
      last_touch_timestamp: lastTouch?.timestamp,
      lastTouchSource: lastTouch?.source,
      lastTouchMedium: lastTouch?.medium,
      lastTouchCampaign: lastTouch?.campaign,
      
      // Journey metrics
      touchpoint_count: journey.length,
      touchpointCount: journey.length,
      days_since_first_touch: firstTouch?.timestamp 
        ? Math.floor((Date.now() - firstTouch.timestamp) / 86400000)
        : 0,
      daysSinceFirstTouch: firstTouch?.timestamp 
        ? Math.floor((Date.now() - firstTouch.timestamp) / 86400000)
        : 0
    };
  }

  /**
   * Determine source from attribution data
   */
  private determineSource(attribution: Attribution): string {
    // If we have a click ID, determine source from that
    if (attribution.clickIdType) {
      const clickIdSources: Record<string, string> = {
        fbclid: 'facebook',
        gclid: 'google',
        ttclid: 'tiktok',
        msclkid: 'bing',
        twclid: 'twitter',
        li_fat_id: 'linkedin',
        sclid: 'snapchat',
        dclid: 'doubleclick',
        epik: 'pinterest'
      };
      
      return clickIdSources[attribution.clickIdType] || 'paid';
    }

    // Check referrer
    if (attribution.referrerHost) {
      const host = attribution.referrerHost.toLowerCase();
      
      // Social sources
      if (host.includes('facebook.com') || host.includes('fb.com')) return 'facebook';
      if (host.includes('twitter.com') || host.includes('t.co') || host.includes('x.com')) return 'twitter';
      if (host.includes('linkedin.com') || host.includes('lnkd.in')) return 'linkedin';
      if (host.includes('instagram.com')) return 'instagram';
      if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
      if (host.includes('tiktok.com')) return 'tiktok';
      if (host.includes('reddit.com')) return 'reddit';
      if (host.includes('pinterest.com')) return 'pinterest';
      
      // Search engines
      if (host.includes('google.')) return 'google';
      if (host.includes('bing.com')) return 'bing';
      if (host.includes('yahoo.com')) return 'yahoo';
      if (host.includes('duckduckgo.com')) return 'duckduckgo';
      if (host.includes('baidu.com')) return 'baidu';
      
      return 'referral';
    }

    return 'direct';
  }

  /**
   * Determine medium from attribution data
   */
  private determineMedium(attribution: Attribution): string {
    // If we have a click ID, it's paid
    if (attribution.clickId) {
      return 'cpc'; // Cost per click
    }

    // Check source
    const source = attribution.source;
    if (!source || source === 'direct') {
      return 'none';
    }

    // Social sources typically organic unless paid
    const socialSources = ['facebook', 'twitter', 'linkedin', 'instagram', 'youtube', 'tiktok', 'reddit', 'pinterest'];
    if (socialSources.includes(source)) {
      return 'social';
    }

    // Search engines
    const searchSources = ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu'];
    if (searchSources.includes(source)) {
      return 'organic';
    }

    return 'referral';
  }

  /**
   * Extract hostname from URL
   */
  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /**
   * Check if attribution has expired
   */
  isAttributionExpired(attribution: Attribution): boolean {
    if (!attribution.timestamp) return true;
    return Date.now() - attribution.timestamp > this.attributionWindow;
  }

  /**
   * Clear expired attribution
   */
  clearExpiredAttribution(): void {
    const firstTouch = this.getFirstTouch();
    const lastTouch = this.getLastTouch();

    if (firstTouch && this.isAttributionExpired(firstTouch)) {
      storage.remove('dl_first_touch');
    }

    if (lastTouch && this.isAttributionExpired(lastTouch)) {
      storage.remove('dl_last_touch');
    }
  }
}