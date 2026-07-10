/**
 * Attribution Tracking Module
 * Handles UTM parameters, click IDs, and customer journey
 */

import { storage, cookies } from './storage';
import { getAllQueryParams, getRegistrableDomain, redactUrl } from './utils';
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
    'sclid',      // Snapchat (canonical internal name — see CLICK_ID_ALIASES)
    'dclid',      // Google Display/DoubleClick
    'epik',       // Pinterest
    'rdt_cid',    // Reddit
    'obclid',     // Outbrain
    'irclid',     // Impact Radius
    'ko_click_id' // Klaviyo
  ];
  // Real ad-platform URL params whose value we store under a canonical internal
  // name. Snapchat appends &ScCid= (alias `sccid`) to the landing URL — it does
  // NOT use `sclid`. Query-param lookup is case-sensitive, so capture the real
  // params and normalize to `sclid`, which ingest / the MV / server-side
  // attribution all key on. Without this, real Snap ad clicks captured nothing.
  private CLICK_ID_ALIASES: Record<string, string> = {
    ScCid: 'sclid',
    sccid: 'sclid',
  };
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

    // Capture UTM parameters.
    // Emit BOTH the canonical `utm_*` key AND the stripped alias (source/medium/...).
    // FSR-13: ingest (event_data.utm_source ?? utmSource) and EVERY attribution MV /
    // lookup pipe key on the prefixed `utm_source`/`utm_campaign` names with no fallback —
    // stripping the prefix left the UTM leg of the attribution read path dead for all web
    // events. The stripped alias is still emitted because the dashboard analytics MVs and
    // determineSource()/determineMedium() read it (and it's the long-standing shape).
    for (const utm of this.UTM_PARAMS) {
      const value = params[utm];
      if (value) {
        attribution[utm] = value; // canonical: utm_source, utm_campaign, ...
        const key = utm.replace('utm_', '') as keyof Attribution;
        attribution[key] = value; // alias: source, campaign, ...
      }
    }

    // Capture click IDs. The first present (by CLICK_IDS priority) is the primary
    // clickId/clickIdType, but ALSO capture every present click ID as its own named
    // field — a single URL can carry both fbclid and gclid (redirect chains, forwarded
    // / re-shared links), and keeping only the first dropped the others' platform
    // attribution entirely. (WEB NEW-3)
    for (const clickId of this.CLICK_IDS) {
      const value = params[clickId];
      if (value) {
        if (!attribution.clickId) {
          attribution.clickId = value;
          attribution.clickIdType = clickId;
        }
        attribution[clickId] = value;
      }
    }

    // Aliased click IDs (e.g. Snap's ScCid/sccid → canonical sclid). Param lookup
    // above is case-sensitive and uses canonical names, so check the real params here.
    for (const [param, canonical] of Object.entries(this.CLICK_ID_ALIASES)) {
      const value = params[param];
      if (value && !attribution[canonical]) {
        if (!attribution.clickId) {
          attribution.clickId = value;
          attribution.clickIdType = canonical;
        }
        attribution[canonical] = value;
      }
    }

    // Capture custom tracked parameters
    for (const param of this.trackedParams) {
      const value = params[param];
      if (value) {
        attribution[param] = value;
      }
    }

    // Capture referrer. 9.A.4: redact secret/PII query-param values (reset tokens,
    // OAuth codes, emails) — this attribution object is stamped onto every event AND
    // persisted into dl_first_touch/dl_last_touch, so it must be clean at capture.
    if (document.referrer) {
      attribution.referrer = redactUrl(document.referrer);
      attribution.referrerHost = this.extractHostname(document.referrer);
    }

    // Capture landing page (redacted — see referrer note above)
    attribution.landingPage = redactUrl(window.location.href);
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

    // Snapchat first-party cookie (Snap Pixel sets _scid). Flows to the server as
    // cookies._scid and is sent on the Snap CAPI event as sc_cookie1 (raw).
    adCookies._scid = cookies.get('_scid');
    
    // Generate _fbp if missing (Facebook browser ID)
    if (!adCookies._fbp && (this.hasClickId('fbclid') || adCookies._fbc)) {
      const timestamp = Date.now();
      // Meta's _fbp format is fb.1.<creationTimeMs>.<randomNumber> where the last
      // segment MUST be a decimal integer. The old base36 string was non-conformant —
      // Meta ignores it (and it can shadow a real _fbp), degrading EMQ. (WEB-17)
      const randomId = Math.floor(Math.random() * 1e10).toString();
      adCookies._fbp = `fb.1.${timestamp}.${randomId}`;
      // Optionally set the cookie for future use
      cookies.set('_fbp', adCookies._fbp, 90);
    }

    // Meta's fbc format is `fb.{subdomainIndex}.{creationTime}.{fbclid}` where
    // creationTime is UNIX time in MILLISECONDS (matches the _fbp generation above
    // and the real _fbc cookie the Meta Pixel writes). Do NOT use seconds here.
    //
    // FSR-14: a returning visitor who clicks a NEW ad must get a FRESH _fbc. The old
    // once-only guards (`!_dl_fbclid_at`, `!_fbc`) meant a new fbclid never refreshed
    // _fbc while a prior 90-day _fbc still existed — Meta then received the OLD
    // campaign's fbc (and an old creationTime that can push the conversion outside the
    // click window) even though event_data carried the new fbclid. We detect a new
    // click by comparing the URL fbclid against the one embedded in the existing _fbc
    // (its 4th dot-segment). `_dl_fbclid_at` stays a pure ms timestamp — the CC bridge /
    // Shopify cart / server-side rebuild forward it as a time, so its format must not
    // change.
    const fbclid = this.getCurrentFbclid();
    if (fbclid) {
      const existingFbc = adCookies._fbc; // captured above (cookies.get('_fbc'))
      const embeddedFbclid = this.extractFbclidFromFbc(existingFbc);
      if (!existingFbc) {
        // No _fbc to compare against. Rebuild it, preferring the persisted click time
        // (covers the case where _fbc was evicted but the same click is still in play),
        // falling back to now if missing/corrupt (Number('abc') = NaN guard).
        const stored = cookies.get('_dl_fbclid_at');
        const parsed = stored ? Number(stored) : NaN;
        const timestamp = Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
        if (!stored) cookies.set('_dl_fbclid_at', String(timestamp), 90);
        adCookies._fbc = `fb.1.${timestamp}.${fbclid}`;
        cookies.set('_fbc', adCookies._fbc, 90);
      } else if (embeddedFbclid && embeddedFbclid !== fbclid) {
        // A NEW ad click landed over a stale _fbc — regenerate with the new fbclid and
        // the CURRENT click time, and overwrite the persisted click time to match.
        const now = Date.now();
        adCookies._fbc = `fb.1.${now}.${fbclid}`;
        cookies.set('_fbc', adCookies._fbc, 90);
        cookies.set('_dl_fbclid_at', String(now), 90);
      }
      // else: same fbclid already embedded in _fbc → leave both cookies untouched.
    }

    // Persist the click time the FIRST time we see gclid in the URL so server-side
    // events can stamp the real click moment even after the _gcl_* cookies evict.
    // (gclid has no synthesized-and-going-stale artifact like _fbc, and Google does not
    // validate a creationTime window the way Meta does, so this stays once-only.)
    const gclid = this.hasClickId('gclid') ? (this.queryParamsCache?.gclid ?? null) : null;
    if (gclid && !cookies.get('_dl_gclid_at')) {
      cookies.set('_dl_gclid_at', String(Date.now()), 90);
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
   * Extract the fbclid embedded in an `_fbc` cookie value
   * (`fb.{subdomainIndex}.{creationTime}.{fbclid}` → the 4th dot-segment), or null if
   * the value is missing/malformed. Used to detect whether a NEW fbclid in the URL
   * differs from the one a prior _fbc was built for. (FSR-14)
   */
  private extractFbclidFromFbc(fbc: string | null | undefined): string | null {
    if (!fbc) return null;
    const parts = fbc.split('.');
    // fb . subdomainIndex . creationTime . fbclid (the fbclid itself may contain no dots)
    if (parts.length < 4 || parts[0] !== 'fb') return null;
    return parts.slice(3).join('.') || null;
  }

  /**
   * Get attribution data for event
   */
  getAttributionData(): Record<string, any> {
    const firstTouch = this.getFirstTouch();
    const lastTouch = this.getLastTouch();
    const journey = this.getJourney();
    let current = this.captureAttribution();

    // A "real" attribution signal on THIS pageview = a click ID, a UTM/campaign, or a
    // referrer/UTM-derived source. determineSource()/determineMedium() FLOOR to
    // 'direct'/'none', so the mere presence of current.source/medium is NOT a signal.
    // The old `hasCurrentAttribution` (truthy because source is always at least 'direct')
    // made the fallback below dead code AND caused storeLastTouch to overwrite a real
    // paid last-touch with 'direct'/'none' on the next internal navigation. (WEB NEW-1)
    const hasRealAttribution = !!(
      current.clickId ||
      current.campaign ||
      (current.source && current.source !== 'direct')
    );

    // Direct / internal navigation: fall back to persisted attribution so the event
    // isn't mis-attributed to 'direct'. FSR-48: prefer the LAST touch (the most recent
    // real signal, e.g. a May Meta click) over the FIRST touch (e.g. a January gclid) —
    // spreading firstTouch carried its stale clickId top-level and credited the older
    // campaign for last-click. Also fall back to whichever of last/first touch is still
    // valid, so an expired first-touch with a live last-touch no longer drops to 'direct'.
    if (!hasRealAttribution) {
      // getLastTouch()/getFirstTouch() already drop expired records, so either is live or
      // null. Prefer last-touch; fall back to first-touch if there's no live last-touch.
      const fallback = lastTouch || firstTouch;
      if (fallback) {
        current = {
          ...fallback,
          referrer: current.referrer,
          referrerHost: current.referrerHost,
          landingPage: current.landingPage,
          landingPath: current.landingPath
        };
      }
    }

    // Capture advertising cookies automatically
    const adCookies = this.captureAdCookies();

    // Only (re)write first/last touch when this pageview carried a REAL signal — never
    // overwrite stored attribution with the 'direct'/'none' floor of an internal nav.
    if (!firstTouch && hasRealAttribution) {
      this.storeFirstTouch(current);
    }
    if (hasRealAttribution) {
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

      // Same-site referrer = internal navigation, NOT a new acquisition source.
      // Without this, a full-page internal nav (referrer = our own domain, common on
      // classic multi-page stores) classifies as 'referral', which makes
      // hasRealAttribution true and overwrites the real paid last-touch. Treat it as
      // direct so the last-touch guard preserves the genuine source.
      const currentHost = (typeof window !== 'undefined' ? window.location.hostname : '').toLowerCase();
      if (currentHost && (host === currentHost || this.isSameRootDomain(host, currentHost))) {
        return 'direct';
      }

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
   * Whether two hosts share the same root domain (eTLD+1 approximation), so that
   * cross-subdomain internal navigation (e.g. shop.example.com → checkout.example.com)
   * is also treated as same-site. Not a full public-suffix parse — good enough to keep
   * internal navs from being mis-classified as referral.
   */
  private isSameRootDomain(a: string, b: string): boolean {
    // FSR-47: use the real eTLD+1 (public-suffix-aware) so a ccTLD merchant
    // (shop.example.co.uk) doesn't collapse every external referrer that merely shares
    // the suffix (google.co.uk → root 'co.uk') into 'direct'.
    return getRegistrableDomain(a) === getRegistrableDomain(b);
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