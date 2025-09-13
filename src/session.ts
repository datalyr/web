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

  constructor(timeout = 30 * 60 * 1000) { // 30 minutes default
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
   */
  createNewSession(): string {
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

    this.incrementSessionCount();
    this.saveSession();
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
   */
  updateActivity(eventType?: string): void {
    const now = Date.now();
    
    // Check if we need a new session
    if (!this.sessionData || !this.isSessionValid(this.sessionData, now)) {
      this.createNewSession();
      return;
    }

    this.lastActivity = now;
    this.sessionData.lastActivity = now;
    this.sessionData.duration = now - this.sessionData.startTime;

    // Update counters
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
   */
  endSession(): void {
    if (this.sessionData) {
      this.sessionData.isActive = false;
      this.saveSession();
    }
    this.sessionId = null;
    this.sessionData = null;
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
   */
  storeAttribution(attribution: Attribution): void {
    const key = `dl_session_${this.sessionId}_attribution`;
    storage.set(key, {
      ...attribution,
      sessionId: this.sessionId,
      timestamp: Date.now()
    });
  }

  /**
   * Get session attribution
   */
  getAttribution(): Attribution | null {
    if (!this.sessionId) return null;
    
    const key = `dl_session_${this.sessionId}_attribution`;
    return storage.get(key);
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