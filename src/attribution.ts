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
    this.attributionWindow = options.attributionWindow || 30 * 24 * 60 * 60 * 1000; // 30 days
    // Merge default tracked params with user-provided ones
    this.trackedParams = [...this.DEFAULT_TRACKED_PARAMS, ...(options.trackedParams || [])];
  }

  /**
   * Capture current attribution from URL
   */
  captureAttribution(): Attribution {
    const params = getAllQueryParams();
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
   * Store first touch attribution
   */
  storeFirstTouch(attribution: Attribution): void {
    const existing = storage.get('dl_first_touch');
    if (!existing) {
      storage.set('dl_first_touch', {
        ...attribution,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Get first touch attribution
   */
  getFirstTouch(): Attribution | null {
    return storage.get('dl_first_touch');
  }

  /**
   * Store last touch attribution
   */
  storeLastTouch(attribution: Attribution): void {
    storage.set('dl_last_touch', {
      ...attribution,
      timestamp: Date.now()
    });
  }

  /**
   * Get last touch attribution
   */
  getLastTouch(): Attribution | null {
    return storage.get('dl_last_touch');
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
   */
  private hasClickId(clickIdType: string): boolean {
    const params = getAllQueryParams();
    return !!params[clickIdType];
  }

  /**
   * Get current fbclid from URL if present
   */
  private getCurrentFbclid(): string | null {
    const params = getAllQueryParams();
    return params.fbclid || null;
  }

  /**
   * Get attribution data for event
   */
  getAttributionData(): Record<string, any> {
    const firstTouch = this.getFirstTouch();
    const lastTouch = this.getLastTouch();
    const journey = this.getJourney();
    const current = this.captureAttribution();
    
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