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

// A 429 is a deliberate backpressure signal, not a transient failure — tagged so the
// send path can route it to the offline queue WITHOUT retrying (which would storm the
// already-overloaded server). See sendBatch / the rateLimitedUntil gate.
class RateLimitError extends Error {}

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
  private offlineProcessing = false; // FIXED (WEB-1): re-entrancy guard for processOfflineQueue
  private inFlight: IngestEventPayload[] = []; // FIXED (WEB-3): batch currently in _flight's keepalive fetch — forceFlush must NOT re-beacon it
  private enabled = true; // FIXED (consent): when false (opt-out / withdrawn analytics consent) all enqueue/flush/drain is a no-op
  private rateLimitedUntil = 0; // FIXED (429): skip flush/drain until the server's Retry-After window passes

  constructor(config: any) {
    // Coerce numeric config to sane values. The old `config.X || default` both turned a
    // legitimate 0 into the default AND let invalid values through — a NEGATIVE batchSize
    // made processOfflineQueue's `splice(0, -1)` loop forever and FREEZE the host tab.
    const clampInt = (v: any, def: number, min: number, max: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : def;
    };
    this.config = {
      batchSize: clampInt(config.batchSize, 10, 1, 1000),
      flushInterval: clampInt(config.flushInterval, 5000, 250, 3_600_000),
      maxRetries: clampInt(config.maxRetries, 5, 0, 20),
      retryDelay: clampInt(config.retryDelay, 1000, 0, 60_000),
      endpoint: config.endpoint || 'https://ingest.datalyr.com',
      fallbackEndpoints: Array.isArray(config.fallbackEndpoints) ? config.fallbackEndpoints : [],
      workspaceId: config.workspaceId,
      debug: config.debug || false,
      criticalEvents: config.criticalEvents || DEFAULT_CRITICAL_EVENTS,
      highPriorityEvents: config.highPriorityEvents || DEFAULT_HIGH_PRIORITY_EVENTS,
      maxOfflineQueueSize: clampInt(config.maxOfflineQueueSize, 100, 1, 100_000)
    };

    this.networkStatus = {
      isOnline: navigator.onLine !== false,
      lastOfflineAt: null,
      lastOnlineAt: null
    };

    this.loadOfflineQueue();
    this.setupNetworkListeners();
    this.startPeriodicFlush();

    // WEB-1: a previous session may have left events in the persisted offline queue.
    // The 'online' listener only fires on an offline→online TRANSITION, which never
    // happens for a visitor who returns already-online — so drain on startup too,
    // otherwise those events (incl. failed revenue conversions) just age out.
    if (this.networkStatus.isOnline && this.offlineQueue.length > 0) {
      setTimeout(() => this.processOfflineQueue(), 1000);
    }
  }

  /**
   * Add event to queue
   */
  enqueue(event: IngestEventPayload): void {
    // Consent gate: opt-out / withdrawn analytics consent stops all sending. (The SDK
    // also gates at track(), but this is the backstop for anything that reaches here.)
    if (!this.enabled) return;

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
    if (!this.enabled) return;
    // FIXED (429): respect the server's Retry-After window instead of hammering it.
    if (Date.now() < this.rateLimitedUntil) return;
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

    // WEB-3 (HIGH-1): mark this batch as in-flight. sendBatch's fetch uses
    // keepalive:true, so it survives an unload that fires mid-flush — forceFlush
    // reads `inFlight` to avoid re-beaconing the very events this fetch is sending.
    // `inFlight` is always the FRONT `batchSize` of this.queue while flushLock holds
    // (enqueue only pushes to the back; flushLock serializes _flush bodies).
    this.inFlight = events;

    try {
      await this.sendBatch(events);
      // SUCCESS: Now it's safe to remove events from queue
      this.queue.splice(0, batchSize);
      this.log(`Successfully sent and removed ${batchSize} events from queue`);
    } catch (error) {
      this.log('Failed to send batch:', error);
      // WEB-8: make the offline queue the SINGLE owner of these events. Previously
      // they stayed in the live queue AND were copied to the offline queue, so a
      // later success on both paths double-sent (relying on server-side dedup).
      // Remove the same slice from the live queue; the offline queue now drains on
      // every periodic tick (WEB-1/WEB-2), so they are still retried, not stranded.
      this.queue.splice(0, batchSize);
      this.moveToOfflineQueue(events);
    } finally {
      this.inFlight = [];
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
          // FIXED (429 retry-storm): honor Retry-After as a SINGLE backoff window. The
          // old code scheduled a flush AND let the throw fall into the generic
          // exponential-backoff retry below — firing ~6 requests inside the window the
          // server asked us to wait, amplifying an ingest overload. Now: record the
          // window and throw a RateLimitError (which the catch does NOT retry). The
          // events move to the offline queue and drain once the window passes.
          this.rateLimitedUntil = Date.now() + Math.max(retryAfter, 1) * 1000;
          this.log(`Rate limited; backing off ${retryAfter}s`);
          throw new RateLimitError('Rate limited (429)');
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.log(`Batch sent successfully to ${currentEndpoint}: ${events.length} events`);
    } catch (error) {
      // A 429 is deliberate backpressure — do NOT retry it here (neither fallback nor
      // backoff). Propagate so the batch moves to the offline queue; the periodic drain
      // resumes only after rateLimitedUntil. This is what prevents the retry storm.
      if (error instanceof RateLimitError) {
        throw error;
      }

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
      // WEB-1/WEB-2: also drain persisted offline events (including failed critical
      // events that enqueue() parked here) on every tick — not only on an 'online'
      // transition that may never fire. This is what gives parked purchase/lead
      // events a retry path while the user stays online.
      if (this.networkStatus.isOnline && this.offlineQueue.length > 0) {
        this.processOfflineQueue();
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
    // Consent leak fix: do NOT persist for a disabled queue. Without this, an
    // in-flight _flush (or critical-event send) that FAILS after optOut() has purged
    // the offline queue would re-write the PII-bearing event to storage AFTER the
    // purge. Gating here (a persistence sink, not just the send sinks) closes it.
    if (!this.enabled) return;

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
    // Defense-in-depth twin of the moveToOfflineQueue gate: never write PII to disk
    // for a disabled (opted-out) queue.
    if (!this.enabled) return;
    // Keep max events based on config
    const toSave = this.offlineQueue.slice(-this.config.maxOfflineQueueSize);
    storage.set(this.OFFLINE_QUEUE_KEY, toSave);
  }

  /**
   * Process offline queue
   */
  private async processOfflineQueue(): Promise<void> {
    // WEB-1: guard against re-entrancy. This is now driven from three places (the
    // 'online' listener, the periodic flush, and the on-load kick); without a guard
    // two of them could splice the same offlineQueue concurrently and double-send.
    if (!this.enabled) return;
    if (Date.now() < this.rateLimitedUntil) return; // FIXED (429): honor Retry-After window
    if (this.offlineProcessing) return;
    if (this.offlineQueue.length === 0) return;
    if (!this.networkStatus.isOnline) return;

    this.offlineProcessing = true;
    try {
      this.log(`Processing ${this.offlineQueue.length} offline events`);

      while (this.offlineQueue.length > 0) {
        // Stop mid-drain if disabled (opt-out during an active drain) — otherwise the
        // unshift-on-failure below would re-persist a batch after optOut's purge.
        if (!this.enabled) break;
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
    } finally {
      this.offlineProcessing = false;
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
   * Build a batch payload from a set of events.
   */
  private buildBatch(events: IngestEventPayload[]): IngestBatchPayload {
    return {
      events,
      batchId: generateUUID(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Force flush (for page unload)
   * FIXED (WEB-3): include the offline queue, chunk under sendBeacon's ~64KB cap,
   * and persist any chunk the browser refuses so it survives to the next page load.
   * Previously this beaconed the live queue as one blob — ignoring the offline queue
   * entirely and silently failing (returning false) whenever the payload exceeded 64KB.
   *
   * Two follow-up review fixes:
   *  - HIGH-1: exclude any batch currently in-flight in _flush(). That batch is being
   *    sent with a keepalive fetch that already survives unload; re-beaconing it would
   *    double-send. (`inFlight` is the front `inFlight.length` events of this.queue.)
   *  - HIGH-2: handleUnload is wired to visibilitychange+pagehide+beforeunload, so this
   *    runs multiple times per lifecycle. Detach what we beacon SYNCHRONOUSLY (clear the
   *    in-memory queues, persist a refused remainder straight to storage rather than back
   *    into this.offlineQueue) so a repeat call finds nothing to re-send.
   */
  async forceFlush(): Promise<void> {
    if (!this.enabled) return;
    if (!navigator.sendBeacon) {
      // No beacon API — best-effort keepalive-fetch drain of both queues.
      await this.flush();
      await this.processOfflineQueue();
      return;
    }

    // Exclude the in-flight batch (its keepalive fetch already carries it).
    const live = this.queue.slice(this.inFlight.length);
    const pending = [...live, ...this.offlineQueue];

    // Detach synchronously: keep only the in-flight front (for _flush to settle) and
    // empty the offline queue, so a second unload event this lifecycle re-enters with
    // nothing to re-beacon. The refused remainder (if any) is persisted to STORAGE
    // below, not back into this.offlineQueue, for exactly this reason.
    this.queue = this.queue.slice(0, this.inFlight.length);
    this.offlineQueue = [];

    if (pending.length === 0) return;

    const MAX_BEACON_BYTES = 60000; // headroom under the browser's ~64KB cap

    // Greedily pack events into chunks bounded by BOTH batchSize and byte size.
    const chunks: IngestEventPayload[][] = [];
    let current: IngestEventPayload[] = [];
    let currentBytes = 2; // approx for the JSON array/object wrapper
    for (const ev of pending) {
      // Byte length (not UTF-16 .length) so multibyte product names / emoji can't
      // under-count and overflow the cap.
      const evBytes = new Blob([JSON.stringify(ev)]).size + 1;
      if (
        current.length > 0 &&
        (current.length >= this.config.batchSize || currentBytes + evBytes > MAX_BEACON_BYTES)
      ) {
        chunks.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(ev);
      currentBytes += evBytes;
    }
    if (current.length > 0) chunks.push(current);

    // Send each chunk; the moment the browser refuses to enqueue one, keep it and
    // everything after it for the next session.
    let failedFrom = -1;
    for (let c = 0; c < chunks.length; c++) {
      const blob = new Blob([JSON.stringify(this.buildBatch(chunks[c]))], {
        type: 'application/json'
      });
      if (!navigator.sendBeacon(this.config.endpoint, blob)) {
        failedFrom = c;
        break;
      }
    }

    if (failedFrom >= 0) {
      const remainder = chunks
        .slice(failedFrom)
        .reduce((acc, c) => acc.concat(c), [] as IngestEventPayload[]);
      // Persist straight to storage (NOT this.offlineQueue) so a repeat unload event
      // won't re-beacon it; the next page load's drain (which uses a normal fetch with
      // no 64KB cap) delivers it. MED-2: log if the maxOfflineQueueSize cap truncates.
      const toPersist = remainder.slice(-this.config.maxOfflineQueueSize);
      if (remainder.length > toPersist.length) {
        this.log(`Offline cap dropped ${remainder.length - toPersist.length} oldest events at unload`);
      }
      storage.set(this.OFFLINE_QUEUE_KEY, toPersist);
      this.log(`sendBeacon refused ${remainder.length} events; persisted ${toPersist.length} for next load`);
    } else {
      this.log('Events sent via sendBeacon');
      storage.remove(this.OFFLINE_QUEUE_KEY);
    }
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
   * Enable/disable all sending. Used by opt-out / withdrawn analytics consent so that
   * events persisted BEFORE opt-out aren't drained afterwards (the periodic drain and
   * the on-load drain both honor this).
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clear the offline queue and its persisted copy (used by opt-out to purge any
   * PII-bearing events that were parked before the user opted out).
   */
  clearOffline(): void {
    this.offlineQueue = [];
    storage.remove(this.OFFLINE_QUEUE_KEY);
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