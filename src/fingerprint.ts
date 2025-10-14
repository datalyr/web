/**
 * Fingerprint Collection Module
 * Collects device fingerprint data for identification
 * Privacy-conscious: respects privacy mode settings
 */

import type { FingerprintData } from './types';

export class FingerprintCollector {
  private privacyMode: 'standard' | 'strict';
  private enableFingerprinting: boolean;
  private heavyFingerprintDone = false;
  private fingerprintCache: Partial<FingerprintData> = {};

  constructor(options: {
    privacyMode?: 'standard' | 'strict';
    enableFingerprinting?: boolean;
  } = {}) {
    this.privacyMode = options.privacyMode || 'standard';
    this.enableFingerprinting = options.enableFingerprinting !== false;
  }

  /**
   * Collect fingerprint data
   * Returns minimal data in strict mode, full data in standard mode
   */
  collect(): FingerprintData {
    // Strict privacy mode - minimal fingerprinting only
    if (this.privacyMode === 'strict' || !this.enableFingerprinting) {
      return this.collectMinimal();
    }

    // Standard mode - collect more data
    return this.collectStandard();
  }

  /**
   * Collect minimal fingerprint data (privacy-friendly)
   * Matches browser tag minimal fingerprinting approach
   */
  private collectMinimal(): FingerprintData {
    const fp: FingerprintData = {
      timezone: this.getTimezone(),
      language: navigator.language || null,
      screen_bucket: this.getScreenBucket(),
      dnt: (navigator.doNotTrack === '1' || (window as any).globalPrivacyControl === true) || null,
      userAgent: navigator.userAgent || null
    };

    // User-Agent Client Hints (modern browsers)
    if ('userAgentData' in navigator) {
      const uaData = (navigator as any).userAgentData;
      fp.userAgentData = {
        brands: uaData.brands || [],
        mobile: uaData.mobile || false,
        platform: uaData.platform || null
      };
    }

    return fp;
  }

  /**
   * Collect standard fingerprint data
   * PRIVACY: Minimal data collection matching browser tag approach
   * Only collects data necessary for basic analytics and attribution
   */
  private collectStandard(): FingerprintData {
    const fingerprint: FingerprintData = {};

    try {
      // PRIVACY: Only collect minimal data needed for attribution
      fingerprint.timezone = this.getTimezone();
      fingerprint.language = navigator.language || null;
      fingerprint.screen_bucket = this.getScreenBucket();
      fingerprint.dnt = (navigator.doNotTrack === '1' || (window as any).globalPrivacyControl === true) || null;
      fingerprint.userAgent = navigator.userAgent || null;

      // User-Agent Client Hints (modern browsers)
      if ('userAgentData' in navigator) {
        const uaData = (navigator as any).userAgentData;
        fingerprint.userAgentData = {
          brands: uaData.brands || [],
          mobile: uaData.mobile || false,
          platform: uaData.platform || null
        };
      }

    } catch (e) {
      console.warn('[Datalyr] Error collecting fingerprint:', e);
    }

    return fingerprint;
  }

  // PRIVACY: Heavy fingerprinting (WebGL, Audio) removed
  // Minimal fingerprinting only for privacy compliance

  /**
   * Get timezone
   */
  private getTimezone(): string | null {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  }

  /**
   * Get coarse screen bucket for basic device classification
   * Rounds to nearest 100px for privacy
   */
  private getScreenBucket(): string | null {
    try {
      if (!window.screen) return null;
      const width = Math.round(screen.width / 100) * 100;
      const height = Math.round(screen.height / 100) * 100;
      return `${width}x${height}`;
    } catch {
      return null;
    }
  }

  // PRIVACY: Unused helper methods removed (coarsen functions, storage tests)
  // Minimal fingerprinting only

  /**
   * Generate fingerprint hash
   */
  async generateHash(data: FingerprintData): Promise<string> {
    try {
      // Sort keys for consistent hashing
      const sortedData = Object.keys(data)
        .sort()
        .reduce((obj, key) => {
          obj[key] = (data as any)[key];
          return obj;
        }, {} as any);

      const str = JSON.stringify(sortedData);
      
      // Use Web Crypto API if available
      if (window.crypto && window.crypto.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      }

      // Fallback to simple hash
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return Math.abs(hash).toString(16);
    } catch {
      return '';
    }
  }
}