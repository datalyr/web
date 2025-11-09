/**
 * Event Queue and Batching Module
 */

import { storage } from './storage';
import { generateUUID, calculateRetryDelay } from './utils';
import type { IngestEventPayload, IngestBatchPayload, NetworkStatus } from './types';

// Default critical events that bypass batching
const DEFAULT_CRITICAL_EVENTS = ['purchase', 'signup', 'subscribe', 'lead', 'conversion'];

// Default high priority events that use faster batching
const DEFAULT_HIGH_PRIORITY_EVENTS = ['add_to_cart', 'begin_checkout', 'view_item', 'search'];

export class EventQueue {
  private queue: IngestEventPayload[] = [];
  private offlineQueue: IngestEventPayload[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicFlushInterval: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;
  private networkStatus: NetworkStatus;
  private config: {
    batchSize: number;
    flushInterval: number;
    maxRetries: number;
    retryDelay: number;
    endpoint: string;
    fallbackEndpoints: string[];
    workspaceId: string;
    debug: boolean;
    criticalEvents: string[];
    highPriorityEvents: string[];
    maxOfflineQueueSize: number;
  };
  private recentEventIds = new Set<string>();
  private MAX_RECENT_EVENT_IDS = 1000;
  private OFFLINE_QUEUE_KEY = 'dl_offline_queue';
  private flushLock = false; // FIXED (DATA-03): Mutex to prevent race conditions
  private offlineQueueLock = false; // FIXED (DATA-03): Separate lock for offline queue operations

  constructor(config: any) {
    this.config = {
      batchSize: config.batchSize || 10,
      flushInterval: config.flushInterval || 5000,
      maxRetries: config.maxRetries || 5,
      retryDelay: config.retryDelay || 1000,
      endpoint: config.endpoint || 'https://ingest.datalyr.com',
      fallbackEndpoints: config.fallbackEndpoints || [],
      workspaceId: config.workspaceId,
      debug: config.debug || false,
      criticalEvents: config.criticalEvents || DEFAULT_CRITICAL_EVENTS,
      highPriorityEvents: config.highPriorityEvents || DEFAULT_HIGH_PRIORITY_EVENTS,
      maxOfflineQueueSize: config.maxOfflineQueueSize || 100
    };

    this.networkStatus = {
      isOnline: navigator.onLine !== false,
      lastOfflineAt: null,
      lastOnlineAt: null
    };

    this.loadOfflineQueue();
    this.setupNetworkListeners();
    this.startPeriodicFlush();
  }

  /**
   * Add event to queue
   */
  enqueue(event: IngestEventPayload): void {
    const eventName = event.event_name; // Use snake_case

    // Check for duplicates (within 500ms window)
    if (this.isDuplicateEvent(event)) {
      this.log('Duplicate event suppressed:', eventName);
      return;
    }

    // CRITICAL FIX (CRITICAL-05): Critical events need proper error handling
    // Instead of calling sendBatch() without await, we add them to queue
    // with immediate flush AND move to offline queue on failure
    if (this.config.criticalEvents.includes(eventName)) {
      this.log('Critical event, sending immediately:', eventName);

      // Send immediately with proper error handling
      this.sendBatch([event]).catch((error) => {
        this.log('Critical event send failed, adding to offline queue:', eventName, error);
        // Move to offline queue to ensure it's not lost
        this.moveToOfflineQueue([event]);
      });

      return;
    }

    // Add to queue
    this.queue.push(event);
    this.log('Event queued:', eventName);

    // Check if we should flush
    if (this.shouldFlush(eventName)) {
      this.flush();
    }
  }

  /**
   * Check if event is duplicate
   * Fixed Issue #32: Use content-based hash instead of UUID
   */
  private isDuplicateEvent(event: IngestEventPayload): boolean {
    // Create content-based hash from eventName + timestamp + key properties
    const contentHash = this.createEventHash(event);

    if (this.recentEventIds.has(contentHash)) {
      return true;
    }

    this.recentEventIds.add(contentHash);

    // Clean up old event IDs
    if (this.recentEventIds.size > this.MAX_RECENT_EVENT_IDS) {
      const toDelete = this.recentEventIds.size - this.MAX_RECENT_EVENT_IDS;
      const iterator = this.recentEventIds.values();
      for (let i = 0; i < toDelete; i++) {
        const next = iterator.next();
        if (!next.done) {
          this.recentEventIds.delete(next.value);
        }
      }
    }

    return false;
  }

  /**
   * Create content-based hash for duplicate detection (Issue #32)
   */
  private createEventHash(event: IngestEventPayload): string {
    const content = [
      event.event_name, // Use snake_case
      event.timestamp,
      JSON.stringify(event.event_data || {}) // Use snake_case
    ].join('|');

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Check if we should flush the queue
   */
  private shouldFlush(eventName?: string): boolean {
    // Check queue size
    if (this.queue.length >= this.config.batchSize) {
      return true;
    }

    // Check for high priority events
    if (eventName && this.config.highPriorityEvents.includes(eventName)) {
      // Use faster flush for high priority
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
      }
      this.batchTimer = setTimeout(() => this.flush(), 1000);
      return false;
    }

    // Set normal batch timer if not already set
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.config.flushInterval);
    }

    return false;
  }

  /**
   * Flush the queue
   * FIXED (DATA-03): Enhanced protection against concurrent flushes
   */
  async flush(): Promise<void> {
    // FIXED (DATA-03): Check both promise and lock for concurrent flush protection
    if (this.flushPromise || this.flushLock) {
      return this.flushPromise || Promise.resolve();
    }

    // Acquire lock
    this.flushLock = true;

    try {
      this.flushPromise = this._flush();
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
      this.flushLock = false;
    }
  }

  /**
   * Internal flush implementation
   * FIXED (CRITICAL-06): Don't remove events from queue until send succeeds
   */
  private async _flush(): Promise<void> {
    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Check if we have events
    if (this.queue.length === 0) {
      return;
    }

    // Check network status
    if (!this.networkStatus.isOnline) {
      this.log('Network offline, queuing events');
      this.moveToOfflineQueue();
      return;
    }

    // CRITICAL FIX: Use slice() to COPY events, don't remove yet
    // Only remove after successful send to prevent data loss
    const batchSize = Math.min(this.config.batchSize, this.queue.length);
    const events = this.queue.slice(0, batchSize);

    try {
      await this.sendBatch(events);
      // SUCCESS: Now it's safe to remove events from queue
      this.queue.splice(0, batchSize);
      this.log(`Successfully sent and removed ${batchSize} events from queue`);
    } catch (error) {
      this.log('Failed to send batch:', error);
      // Don't remove from queue - events stay for retry
      // Move to offline queue for persistent storage
      this.moveToOfflineQueue(events);
    }
  }

  /**
   * Send batch of events
   */
  private async sendBatch(events: IngestEventPayload[], retries = 0, endpointIndex = 0): Promise<void> {
    const batchPayload: IngestBatchPayload = {
      events,
      batchId: generateUUID(),
      timestamp: new Date().toISOString()
    };

    // Get current endpoint (main or fallback)
    const endpoints = [this.config.endpoint, ...this.config.fallbackEndpoints];
    const currentEndpoint = endpoints[endpointIndex] || this.config.endpoint;

    try {
      const response = await fetch(currentEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Batch-Size': events.length.toString()
        },
        body: JSON.stringify(batchPayload),
        keepalive: true
      });

      if (!response.ok) {
        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
          this.log(`Rate limited, retrying after ${retryAfter}s`);

          // FIXED (CRITICAL-06): Don't unshift() - events are still in queue!
          // With the new fix, events aren't removed until success, so they're
          // already in the queue. Just schedule a retry flush.
          setTimeout(() => {
            this.flush();
          }, retryAfter * 1000);

          // Throw to trigger catch block which moves events to offline queue
          throw new Error(`Rate limited (429), retry after ${retryAfter}s`);
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.log(`Batch sent successfully to ${currentEndpoint}: ${events.length} events`);
    } catch (error) {
      // Try next fallback endpoint if available
      if (endpointIndex < endpoints.length - 1) {
        this.log(`Failed on ${currentEndpoint}, trying fallback ${endpointIndex + 1}`);
        return this.sendBatch(events, 0, endpointIndex + 1);
      }

      // Retry with exponential backoff on current endpoint
      if (retries < this.config.maxRetries) {
        const delay = calculateRetryDelay(retries, this.config.retryDelay);
        this.log(`Retrying batch in ${delay}ms (attempt ${retries + 1}/${this.config.maxRetries})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.sendBatch(events, retries + 1, endpointIndex);
      }

      throw error;
    }
  }

  /**
   * Setup network status listeners
   */
  private setupNetworkListeners(): void {
    window.addEventListener('online', () => {
      this.networkStatus.isOnline = true;
      this.networkStatus.lastOnlineAt = Date.now();
      this.log('Network connection restored');
      
      // Process offline queue
      setTimeout(() => this.processOfflineQueue(), 1000);
    });

    window.addEventListener('offline', () => {
      this.networkStatus.isOnline = false;
      this.networkStatus.lastOfflineAt = Date.now();
      this.log('Network connection lost');
    });
  }

  /**
   * Start periodic flush timer
   */
  private startPeriodicFlush(): void {
    this.periodicFlushInterval = setInterval(() => {
      if (this.queue.length > 0) {
        this.flush();
      }
    }, this.config.flushInterval);
  }

  /**
   * Stop periodic flush timer
   */
  private stopPeriodicFlush(): void {
    if (this.periodicFlushInterval) {
      clearInterval(this.periodicFlushInterval);
      this.periodicFlushInterval = null;
    }
  }

  /**
   * Move events to offline queue
   * Fixed Issue #33: Enforce size limit when adding, not just when saving
   * FIXED (DATA-03): Added mutex lock to prevent race conditions
   * FIXED (CRITICAL-06): Can now accept specific events or move entire queue
   */
  private moveToOfflineQueue(events?: IngestEventPayload[]): void {
    // FIXED (DATA-03): Check if offline queue operation already in progress
    if (this.offlineQueueLock) {
      console.warn('[Datalyr Queue] Offline queue operation already in progress');
      return;
    }

    // Acquire lock
    this.offlineQueueLock = true;

    try {
      if (events) {
        // Move specific events to offline queue
        this.offlineQueue.push(...events);
      } else {
        // Move entire queue to offline queue
        this.offlineQueue.push(...this.queue);
        this.queue = [];
      }

      // Issue #33: Enforce limit here, not just in saveOfflineQueue
      if (this.offlineQueue.length > this.config.maxOfflineQueueSize) {
        const excess = this.offlineQueue.length - this.config.maxOfflineQueueSize;
        this.offlineQueue.splice(0, excess); // Remove oldest events
      }

      this.saveOfflineQueue();
    } finally {
      // Always release lock
      this.offlineQueueLock = false;
    }
  }

  /**
   * Load offline queue from storage
   */
  private loadOfflineQueue(): void {
    const stored = storage.get(this.OFFLINE_QUEUE_KEY, []);
    if (Array.isArray(stored)) {
      this.offlineQueue = stored;
      this.log(`Loaded ${this.offlineQueue.length} offline events`);
    }
  }

  /**
   * Save offline queue to storage
   */
  private saveOfflineQueue(): void {
    // Keep max events based on config
    const toSave = this.offlineQueue.slice(-this.config.maxOfflineQueueSize);
    storage.set(this.OFFLINE_QUEUE_KEY, toSave);
  }

  /**
   * Process offline queue
   */
  private async processOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) return;

    this.log(`Processing ${this.offlineQueue.length} offline events`);

    while (this.offlineQueue.length > 0) {
      const batch = this.offlineQueue.splice(0, this.config.batchSize);
      
      try {
        await this.sendBatch(batch);
        this.saveOfflineQueue();
      } catch (error) {
        this.log('Failed to send offline batch:', error);
        // Put back in queue
        this.offlineQueue.unshift(...batch);
        this.saveOfflineQueue();
        break;
      }
    }

    if (this.offlineQueue.length === 0) {
      storage.remove(this.OFFLINE_QUEUE_KEY);
    }
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get offline queue size
   */
  getOfflineQueueSize(): number {
    return this.offlineQueue.length;
  }

  /**
   * Get network status
   */
  getNetworkStatus(): NetworkStatus {
    return { ...this.networkStatus };
  }

  /**
   * Force flush (for page unload)
   */
  async forceFlush(): Promise<void> {
    // Try sendBeacon first for reliability
    if (navigator.sendBeacon && this.queue.length > 0) {
      const batchPayload: IngestBatchPayload = {
        events: this.queue,
        batchId: generateUUID(),
        timestamp: new Date().toISOString()
      };

      const blob = new Blob([JSON.stringify(batchPayload)], {
        type: 'application/json'
      });

      const success = navigator.sendBeacon(this.config.endpoint, blob);
      if (success) {
        this.log('Events sent via sendBeacon');
        this.queue = [];
        return;
      }
    }

    // Fallback to regular flush
    await this.flush();
  }

  /**
   * Clear queue
   */
  clear(): void {
    this.queue = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Debug logging
   */
  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[Datalyr Queue]', ...args);
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopPeriodicFlush();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    // Save any remaining events to offline queue
    if (this.queue.length > 0) {
      this.moveToOfflineQueue();
    }
  }
}