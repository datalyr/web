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
   */
  private collectMinimal(): FingerprintData {
    return {
      timezone: this.getTimezone(),
      language: navigator.language || null,
      platform: navigator.platform || null,
      canvasEnabled: false,
      localStorageAvailable: this.testStorage('localStorage'),
      sessionStorageAvailable: this.testStorage('sessionStorage')
    };
  }

  /**
   * Collect standard fingerprint data
   */
  private collectStandard(): FingerprintData {
    const fingerprint: FingerprintData = {};

    try {
      // Basic browser data
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

      // Language settings
      fingerprint.language = navigator.language || null;
      fingerprint.languages = navigator.languages ? 
        navigator.languages.slice(0, 2) : null; // Limit to 2 for privacy

      // Platform and browser features
      fingerprint.platform = navigator.platform || null;
      fingerprint.cookieEnabled = navigator.cookieEnabled || null;
      fingerprint.doNotTrack = navigator.doNotTrack || null;

      // Hardware (coarsened for privacy)
      fingerprint.hardwareConcurrency = this.coarsenHardwareConcurrency();
      fingerprint.deviceMemory = this.coarsenDeviceMemory();
      fingerprint.maxTouchPoints = navigator.maxTouchPoints > 0 ? 'touch' : 'no-touch';

      // Screen (coarsened)
      fingerprint.screenResolution = this.getScreenResolution();
      fingerprint.colorDepth = screen.colorDepth || null;
      fingerprint.pixelRatio = this.coarsenPixelRatio();

      // Timezone
      fingerprint.timezone = this.getTimezone();
      fingerprint.timezoneOffset = this.coarsenTimezoneOffset();

      // Canvas fingerprinting disabled for privacy
      fingerprint.canvasEnabled = false;

      // Plugins count only (not details for privacy)
      fingerprint.pluginsCount = navigator.plugins ? navigator.plugins.length : null;

      // Storage availability
      fingerprint.localStorageAvailable = this.testStorage('localStorage');
      fingerprint.sessionStorageAvailable = this.testStorage('sessionStorage');
      fingerprint.indexedDBAvailable = this.testIndexedDB();

      // Add cached heavy fingerprint data if available
      if (this.heavyFingerprintDone) {
        Object.assign(fingerprint, this.fingerprintCache);
      }

    } catch (e) {
      console.warn('[Datalyr] Error collecting fingerprint:', e);
    }

    return fingerprint;
  }

  /**
   * Collect heavy fingerprint data (WebGL, Audio)
   * Called lazily on first event to improve page load performance
   */
  async collectHeavyFingerprint(): Promise<void> {
    if (this.heavyFingerprintDone || this.privacyMode === 'strict') {
      return;
    }

    try {
      // WebGL fingerprinting
      const webglData = this.getWebGLFingerprint();
      if (webglData) {
        this.fingerprintCache.webglVendor = webglData.vendor;
        this.fingerprintCache.webglRenderer = webglData.renderer;
      }

      // Audio fingerprinting
      const audioData = await this.getAudioFingerprint();
      if (audioData) {
        this.fingerprintCache.audioSampleRate = audioData.sampleRate;
        this.fingerprintCache.audioState = audioData.state;
        this.fingerprintCache.audioMaxChannels = audioData.maxChannels;
      }

      this.heavyFingerprintDone = true;
    } catch (e) {
      console.warn('[Datalyr] Heavy fingerprinting failed:', e);
    }
  }

  /**
   * Get WebGL fingerprint
   */
  private getWebGLFingerprint(): { vendor: string; renderer: string } | null {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      
      if (!gl) return null;

      const debugInfo = (gl as any).getExtension('WEBGL_debug_renderer_info');
      if (!debugInfo) {
        return {
          vendor: (gl as any).getParameter((gl as any).VENDOR) || 'unknown',
          renderer: (gl as any).getParameter((gl as any).RENDERER) || 'unknown'
        };
      }

      return {
        vendor: (gl as any).getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'unknown',
        renderer: (gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown'
      };
    } catch {
      return null;
    }
  }

  /**
   * Get audio fingerprint
   */
  private async getAudioFingerprint(): Promise<any> {
    try {
      const AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return null;

      const audioCtx = new AudioContext();
      const result = {
        sampleRate: audioCtx.sampleRate || null,
        state: audioCtx.state || null,
        maxChannels: audioCtx.destination?.maxChannelCount || null
      };

      // Close context to free resources
      if (audioCtx.close) {
        await audioCtx.close();
      }

      return result;
    } catch {
      return null;
    }
  }

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
   * Get screen resolution (coarsened)
   */
  private getScreenResolution(): string | null {
    try {
      const width = Math.round(screen.width / 100) * 100;
      const height = Math.round(screen.height / 100) * 100;
      return `${width}x${height}`;
    } catch {
      return null;
    }
  }

  /**
   * Coarsen hardware concurrency for privacy
   */
  private coarsenHardwareConcurrency(): string | number | null {
    try {
      const cores = navigator.hardwareConcurrency;
      if (!cores) return null;
      return cores > 8 ? '8+' : cores;
    } catch {
      return null;
    }
  }

  /**
   * Coarsen device memory for privacy
   */
  private coarsenDeviceMemory(): string | number | null {
    try {
      const memory = (navigator as any).deviceMemory;
      if (!memory) return null;
      return memory > 4 ? '4+' : memory;
    } catch {
      return null;
    }
  }

  /**
   * Coarsen pixel ratio for privacy
   */
  private coarsenPixelRatio(): string | null {
    try {
      const ratio = window.devicePixelRatio;
      if (!ratio) return null;
      
      // Round to common values
      if (ratio <= 1) return '1';
      if (ratio <= 1.5) return '1.5';
      if (ratio <= 2) return '2';
      if (ratio <= 3) return '3';
      return '3+';
    } catch {
      return null;
    }
  }

  /**
   * Coarsen timezone offset for privacy
   */
  private coarsenTimezoneOffset(): number | null {
    try {
      const offset = new Date().getTimezoneOffset();
      // Round to nearest 30 minutes
      return Math.round(offset / 30) * 30;
    } catch {
      return null;
    }
  }

  /**
   * Test if storage is available
   */
  private testStorage(type: 'localStorage' | 'sessionStorage'): boolean {
    try {
      const storage = window[type];
      const testKey = '__dl_test__';
      storage.setItem(testKey, '1');
      storage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test if IndexedDB is available
   */
  private testIndexedDB(): boolean {
    try {
      return !!window.indexedDB;
    } catch {
      return false;
    }
  }

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