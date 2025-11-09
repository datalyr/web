/**
 * Session Management Module
 */

import { storage } from './storage';
import { generateUUID } from './utils';
import type { SessionData, Attribution } from './types';

export class SessionManager {
  private sessionId: string | null = null;
  private sessionData: SessionData | null = null;
  private sessionTimeout: number;
  private lastActivity: number = Date.now();
  private SESSION_KEY = 'dl_session_data';
  private activityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private activityListeners: Array<{ event: string; handler: EventListener }> = [];
  private sessionCreationLock = false; // FIXED (DATA-02): Mutex to prevent race conditions

  constructor(timeout = 60 * 60 * 1000) { // 60 minutes default (matches docs)
    this.sessionTimeout = timeout;
    this.initSession();
    this.setupActivityMonitor();
  }

  /**
   * Initialize or restore session
   */
  private initSession(): void {
    const storedSession = storage.get(this.SESSION_KEY);
    const now = Date.now();

    if (storedSession && this.isSessionValid(storedSession, now)) {
      // Restore existing session
      this.sessionData = storedSession;
      this.sessionId = storedSession.id;
      this.lastActivity = now;
    } else {
      // Create new session
      this.createNewSession();
    }
  }

  /**
   * Check if session is still valid
   */
  private isSessionValid(session: SessionData, now: number): boolean {
    const timeSinceActivity = now - session.lastActivity;
    return timeSinceActivity < this.sessionTimeout && session.isActive;
  }

  /**
   * Create a new session
   *
   * FIXED (DATA-02): Added mutex lock to prevent race conditions
   */
  createNewSession(): string {
    // FIXED (DATA-02): Check if session creation already in progress
    if (this.sessionCreationLock) {
      // Wait for ongoing session creation
      console.log('[Datalyr Session] Session creation already in progress, returning existing ID');
      return this.sessionId || '';
    }

    // Acquire lock
    this.sessionCreationLock = true;

    try {
      const now = Date.now();
      this.sessionId = `sess_${generateUUID()}`;

      this.sessionData = {
        id: this.sessionId,
        startTime: now,
        lastActivity: now,
        pageViews: 0,
        events: 0,
        duration: 0,
        isActive: true
      };

      this.saveSession();
      // Issue #25: Increment AFTER session created successfully
      this.incrementSessionCount();

      return this.sessionId;
    } finally {
      // Always release lock
      this.sessionCreationLock = false;
    }
  }

  /**
   * Rotate session ID (security measure)
   *
   * FIXED (DATA-05): Called when user identifies to prevent session fixation attacks
   * Keeps session data but generates new session ID
   */
  rotateSessionId(): string {
    const now = Date.now();
    const oldSessionId = this.sessionId;

    // Generate new session ID
    this.sessionId = `sess_${generateUUID()}`;

    // Preserve session data but update ID
    if (this.sessionData) {
      this.sessionData.id = this.sessionId;
      this.sessionData.lastActivity = now;
      this.saveSession();

      // Clean up old session data
      if (oldSessionId) {
        storage.remove(`dl_session_${oldSessionId}_attribution`);
      }

      console.log(`[Datalyr Session] Rotated session ID from ${oldSessionId} to ${this.sessionId}`);
    } else {
      // No existing session, create new one
      this.createNewSession();
    }

    return this.sessionId;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    if (!this.sessionId || !this.isSessionActive()) {
      this.createNewSession();
    }
    return this.sessionId!;
  }

  /**
   * Get session data
   */
  getSessionData(): SessionData | null {
    return this.sessionData;
  }

  /**
   * Update session activity
   * FIXED (CRITICAL-04): Check session validity BEFORE updating lastActivity
   * This ensures sessions actually timeout after the configured period
   */
  updateActivity(eventType?: string): void {
    const now = Date.now();

    // CRITICAL FIX: Check session validity BEFORE updating lastActivity
    // If we update lastActivity first, sessions will never timeout!
    if (!this.sessionData || !this.isSessionValid(this.sessionData, now)) {
      this.createNewSession();
      return;
    }

    // Session is valid - update activity timestamp
    this.lastActivity = now;
    this.sessionData.lastActivity = now;
    this.sessionData.duration = now - this.sessionData.startTime;

    // Update counters (only if session is valid)
    if (eventType === 'pageview' || eventType === 'page_view') {
      this.sessionData.pageViews++;
    }
    this.sessionData.events++;

    this.saveSession();
  }

  /**
   * Check if session is active
   */
  isSessionActive(): boolean {
    if (!this.sessionData) return false;
    
    const now = Date.now();
    return this.isSessionValid(this.sessionData, now);
  }

  /**
   * End the current session
   * Fixed Issue #23: Stop activity monitor when session ends
   */
  endSession(): void {
    if (this.sessionData) {
      this.sessionData.isActive = false;
      this.saveSession();
    }
    this.sessionId = null;
    this.sessionData = null;
    // Issue #23: Clean up activity monitor when session ends
    this.destroy();
  }

  /**
   * Save session to storage
   */
  private saveSession(): void {
    if (this.sessionData) {
      storage.set(this.SESSION_KEY, this.sessionData);
    }
  }

  /**
   * Get session timeout
   */
  getTimeout(): number {
    return this.sessionTimeout;
  }

  /**
   * Set session timeout
   */
  setTimeout(timeout: number): void {
    this.sessionTimeout = timeout;
  }

  /**
   * Store session attribution
   * Fixed Issue #24: Use single key instead of one per session
   */
  storeAttribution(attribution: Attribution): void {
    storage.set('dl_current_session_attribution', {
      ...attribution,
      sessionId: this.sessionId,
      timestamp: Date.now()
    });
  }

  /**
   * Get session attribution
   * Fixed Issue #24: Use single key instead of one per session
   * FIXED (CRITICAL-04): Verify session is still active before returning attribution
   */
  getAttribution(): Attribution | null {
    if (!this.sessionId) return null;

    // CRITICAL FIX: Verify session is still active
    if (!this.isSessionActive()) {
      return null;
    }

    const data = storage.get('dl_current_session_attribution');
    // Only return if it matches current session
    if (data && data.sessionId === this.sessionId) {
      return data;
    }
    return null;
  }

  /**
   * Get session metrics
   */
  getMetrics(): Record<string, any> {
    if (!this.sessionData) return {};

    return {
      session_id: this.sessionId,
      session_duration: this.sessionData.duration,
      session_page_views: this.sessionData.pageViews,
      session_events: this.sessionData.events,
      session_start: this.sessionData.startTime,
      time_since_session_start: Date.now() - this.sessionData.startTime
    };
  }

  /**
   * Setup activity monitor for automatic session timeout
   */
  private setupActivityMonitor(): void {
    // Monitor user activity
    const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    
    const handleActivity = () => {
      const now = Date.now();
      if (this.sessionData && now - this.lastActivity > 1000) { // Debounce 1 second
        this.updateActivity();
      }
    };

    activityEvents.forEach(event => {
      window.addEventListener(event, handleActivity, { passive: true, capture: true });
      this.activityListeners.push({ event, handler: handleActivity });
    });

    // Check for session timeout periodically
    this.activityCheckInterval = setInterval(() => {
      if (this.sessionData && !this.isSessionActive()) {
        this.createNewSession();
      }
    }, 60000); // Check every minute
  }

  /**
   * Cleanup listeners and timers
   */
  destroy(): void {
    // Remove activity listeners
    this.activityListeners.forEach(({ event, handler }) => {
      window.removeEventListener(event, handler);
    });
    this.activityListeners = [];

    // Clear interval
    if (this.activityCheckInterval) {
      clearInterval(this.activityCheckInterval);
      this.activityCheckInterval = null;
    }
  }

  /**
   * Get session number (count of sessions)
   */
  getSessionNumber(): number {
    const count = storage.get('dl_session_count', 0);
    return count + 1;
  }

  /**
   * Increment session count
   */
  private incrementSessionCount(): void {
    const count = storage.get('dl_session_count', 0);
    storage.set('dl_session_count', count + 1);
  }
}