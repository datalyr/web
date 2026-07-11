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

// A permanent (non-retryable) failure — a 4xx other than 408/429 (invalid event shape,
// origin not allowed, auth). Retrying or parking it just head-of-line-blocks the offline
// queue forever and hammers ingest. Tagged so the send paths DROP the batch instead of
// unshifting it back to the head. (FSR-55)
class PermanentError extends Error {
  constructor(public status: number, message?: string) {
    super(message || `HTTP ${status}`);
  }
}

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
  private consentCheck?: () => boolean; // TR-15: live consent gate re-evaluated at DRAIN time (not just the latched `enabled`)
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

    // Critical events (purchase/signup/lead/…) send immediately, bypassing the batch.
    // FSR-16: persist the event to the offline queue BEFORE the first send and remove it
    // on confirmed delivery. Previously the event existed ONLY inside the sendBatch retry
    // closure during backoff (~31s) — not in any tracked queue — so a tab close mid-retry
    // (the most plausible moment after checkout) lost the purchase permanently: forceFlush
    // / destroy never saw it. Server-side event_id dedup makes the at-least-once re-send
    // safe.
    if (this.config.criticalEvents.includes(eventName)) {
      this.log('Critical event, sending immediately:', eventName);

      this.persistCriticalEvent(event);

      this.sendBatch([event])
        .then(() => {
          // Delivered — drop the persisted copy so it isn't replayed next load.
          this.removeFromOfflineQueue(event.event_id);
        })
        .catch((error) => {
          if (error instanceof PermanentError) {
            this.log('Critical event permanently rejected, dropping:', eventName, error);
            this.removeFromOfflineQueue(event.event_id);
            return;
          }
          // Leave it persisted: the periodic drain + next-load drain retry it, and an
          // unload mid-retry can now beacon it (it's in the offline queue). (FSR-16)
          this.log('Critical event send failed, retained in offline queue:', eventName, error);
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
      // FSR-55: don't park a permanently-rejected batch — it would never succeed and
      // would block the offline drain. Drop it.
      if (error instanceof PermanentError) {
        this.log(`Dropping ${events.length} events — permanent error ${error.status}`);
      } else {
        this.moveToOfflineQueue(events);
      }
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

    const body = JSON.stringify(batchPayload);
    // FSR-54: keepalive requests share a 64KB in-flight quota (Fetch spec) — a larger
    // body fails INSTANTLY with a network error, then retries through every fallback +
    // backoff (all failing the same way) and parks in the offline queue, where it
    // head-of-line-blocks the drain forever. keepalive only matters for unload survival,
    // so only request it when the body is safely under the cap; oversized batches go via
    // a normal fetch (no cap) and succeed.
    const useKeepalive = new Blob([body]).size <= 60000;

    // First-party endpoint (the customer's own tracking host, never *.datalyr.com — set
    // by the script-origin auto-derive): send the cookie cross-subdomain so the edge can
    // read/refresh the server-set, ITP-durable visitor_id. Legacy datalyr.com endpoints
    // stay credential-less — unchanged behavior for every existing install.
    let firstPartyEndpoint = false;
    try {
      firstPartyEndpoint = !/(^|\.)datalyr\.com$/i.test(new URL(currentEndpoint).hostname);
    } catch {
      /* malformed endpoint — leave false */
    }

    try {
      const response = await fetch(currentEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Batch-Size': events.length.toString()
        },
        body,
        keepalive: useKeepalive,
        ...(firstPartyEndpoint ? { credentials: 'include' as RequestCredentials } : {})
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

        // FSR-55: a 4xx other than 408 (timeout) is PERMANENT — invalid event shape
        // (400), origin not allowed (403), auth (401). Retrying / parking it just blocks
        // the queue and hammers ingest forever. Tag it so the caller drops the batch.
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          throw new PermanentError(response.status, `HTTP ${response.status}: ${response.statusText}`);
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.log(`Batch sent successfully to ${currentEndpoint}: ${events.length} events`);
    } catch (error) {
      // A 429 is deliberate backpressure and a 4xx is permanent — do NOT retry either
      // (neither fallback nor backoff). Propagate so the caller routes them correctly
      // (offline queue for 429, drop for permanent). This prevents the retry storm.
      if (error instanceof RateLimitError || error instanceof PermanentError) {
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
   * Persist a critical event to the offline queue BEFORE its immediate send, so it
   * survives an unload during the send/backoff window. Deduped on event_id so a
   * re-enqueue can't double-store it. (FSR-16)
   */
  private persistCriticalEvent(event: IngestEventPayload): void {
    if (!this.enabled) return;
    if (this.offlineQueue.some(e => e.event_id === event.event_id)) return;
    this.offlineQueue.push(event);
    if (this.offlineQueue.length > this.config.maxOfflineQueueSize) {
      this.offlineQueue.splice(0, this.offlineQueue.length - this.config.maxOfflineQueueSize);
    }
    this.saveOfflineQueue();
  }

  /**
   * Remove a delivered/dropped event from the offline queue by event_id, and clear the
   * persisted copy when the queue empties. (FSR-16)
   */
  private removeFromOfflineQueue(eventId: string): void {
    const before = this.offlineQueue.length;
    this.offlineQueue = this.offlineQueue.filter(e => e.event_id !== eventId);
    if (this.offlineQueue.length === before) return;
    if (this.offlineQueue.length === 0) {
      storage.remove(this.OFFLINE_QUEUE_KEY);
    } else {
      this.saveOfflineQueue();
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
    // TR-15: re-check consent at DRAIN time. A returning DECLINED visitor whose consent
    // signal loads asynchronously (Shopify customerPrivacy) fires no visitorConsentCollected
    // event, so `enabled` stayed at its fail-open init value. If consent now says no, latch
    // off and PURGE the persisted backlog instead of draining it (a later grant re-enables
    // via setEnabled). Mirrors the withdrawal purge in optOut()/setConsent().
    if (this.consentCheck && this.consentCheck() === false) {
      this.enabled = false;
      this.clearOffline();
      return;
    }
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
          // FSR-55: a permanently-rejected (4xx) batch must NOT go back to the head —
          // that would block every event behind it forever and hammer ingest every tick.
          // Drop it (already spliced off the front) and keep draining the rest.
          if (error instanceof PermanentError) {
            this.log(`Dropping poison offline batch (${batch.length}) — permanent error ${error.status}`);
            this.saveOfflineQueue();
            continue;
          }
          this.log('Failed to send offline batch:', error);
          // Transient/rate-limited: put the batch back at the head and stop this drain;
          // the next tick (after any rateLimitedUntil window) retries.
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
   * Force flush. Called on visibilitychange:hidden (NON-terminal — an ordinary tab
   * switch / mobile background) and on pagehide+beforeunload (terminal unload).
   *
   * FSR-15: the old single path beaconed BOTH queues on EVERY visibilitychange and then
   * storage.remove()'d the persisted offline copy on sendBeacon()===true. But sendBeacon
   * true only means the browser ENQUEUED the request — not that it was delivered. The
   * offline queue exists precisely because earlier sends failed (ingest down / 5xx / 429);
   * a single alt-tab during that outage beaconed the whole backlog into the dead endpoint
   * and ERASED the persisted copy, so nothing replayed when ingest recovered. It also
   * ignored rateLimitedUntil, firing beacons straight into the Retry-After window.
   *
   * Now:
   *  - Non-terminal (tab switch): deliver the LIVE queue via a response-checked keepalive
   *    fetch (flush) and response-check-drain the offline backlog (processOfflineQueue) —
   *    neither erases the backlog on failure. The destructive beacon path is not used.
   *  - Terminal (unload): beacon live+offline best-effort, but PERSIST everything first
   *    and NEVER storage.remove() on a mere beacon enqueue. The next page load's
   *    response-checked drain (normal fetch, no 64KB cap) is the source of truth and
   *    clears the copy; server event_id dedup makes the potential double-send safe.
   *  - Both paths honor rateLimitedUntil (don't beacon/flush into the backoff window).
   *
   * Still excludes the in-flight _flush batch (its keepalive fetch already carries it,
   * HIGH-1), and detaches synchronously so a repeat unload event this lifecycle re-enters
   * with nothing to re-beacon (HIGH-2).
   */
  async forceFlush(isTerminal = false): Promise<void> {
    if (!this.enabled) return;

    if (!isTerminal) {
      // Non-terminal visibilitychange: the page is still alive, so use the
      // response-checked send paths (keepalive fetch) — they move failures to the
      // persisted offline queue rather than erasing it. Within the 429 window, leave
      // everything parked.
      if (Date.now() < this.rateLimitedUntil) return;
      await this.flush();
      await this.processOfflineQueue();
      return;
    }

    // Terminal unload.
    // Exclude the in-flight batch (its keepalive fetch already carries it).
    const live = this.queue.slice(this.inFlight.length);
    const pending = [...live, ...this.offlineQueue];

    // Detach the IN-MEMORY queues synchronously so a second unload event this lifecycle
    // finds nothing to re-beacon (HIGH-2). The persisted STORAGE copy below is the
    // durable record and is deliberately NOT removed on a successful beacon. (FSR-15)
    this.queue = this.queue.slice(0, this.inFlight.length);
    this.offlineQueue = [];

    if (pending.length === 0) return;

    // Persist the full backlog FIRST so it survives no matter what sendBeacon reports.
    // The next load's response-checked drain delivers + clears it (dedup-safe). (FSR-15)
    if (this.enabled) {
      const toPersist = pending.slice(-this.config.maxOfflineQueueSize);
      if (pending.length > toPersist.length) {
        this.log(`Offline cap dropped ${pending.length - toPersist.length} oldest events at unload`);
      }
      storage.set(this.OFFLINE_QUEUE_KEY, toPersist);
    }

    // Within the 429 window, don't beacon into it — the persisted copy drains next load.
    if (Date.now() < this.rateLimitedUntil) return;
    if (!navigator.sendBeacon) return; // no beacon API — next load fetch-drains the copy

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

    // Best-effort early delivery. We do NOT storage.remove() on success — the persisted
    // copy is the source of truth for the next load (sendBeacon true ≠ delivered).
    let beaconed = 0;
    for (const chunk of chunks) {
      const blob = new Blob([JSON.stringify(this.buildBatch(chunk))], {
        type: 'application/json'
      });
      if (!navigator.sendBeacon(this.config.endpoint, blob)) break;
      beaconed += chunk.length;
    }
    this.log(`forceFlush(terminal): beaconed ${beaconed}/${pending.length} events; persisted copy retained for next-load drain`);
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
   * TR-15: register a live consent predicate the offline drain re-evaluates at drain time.
   * `enabled` is latched at init to a fail-open value (Shopify's customerPrivacy loads
   * async), and a returning DECLINED visitor fires no visitorConsentCollected event — so
   * without this, their persisted backlog would drain before the decline is known.
   */
  setConsentCheck(fn: () => boolean): void {
    this.consentCheck = fn;
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