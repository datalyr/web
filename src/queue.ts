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
    const eventName = event.eventName;

    // Check for duplicates (within 500ms window)
    if (this.isDuplicateEvent(event)) {
      this.log('Duplicate event suppressed:', eventName);
      return;
    }

    // Critical events bypass queue
    if (this.config.criticalEvents.includes(eventName)) {
      this.log('Critical event, sending immediately:', eventName);
      this.sendBatch([event]);
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
   */
  private isDuplicateEvent(event: IngestEventPayload): boolean {
    const eventId = event.eventId;
    
    if (this.recentEventIds.has(eventId)) {
      return true;
    }

    this.recentEventIds.add(eventId);

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
   */
  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = this._flush();
    await this.flushPromise;
    this.flushPromise = null;
  }

  /**
   * Internal flush implementation
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

    // Get events to send
    const events = this.queue.splice(0, this.config.batchSize);
    
    try {
      await this.sendBatch(events);
    } catch (error) {
      this.log('Failed to send batch:', error);
      // Move to offline queue for retry
      this.offlineQueue.push(...events);
      this.saveOfflineQueue();
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
          
          setTimeout(() => {
            this.queue.unshift(...events);
          }, retryAfter * 1000);
          
          return;
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
   */
  private moveToOfflineQueue(): void {
    this.offlineQueue.push(...this.queue);
    this.queue = [];
    this.saveOfflineQueue();
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