/**
 * Regression tests for the queue data-loss / double-send paths fixed in 1.7.1
 * (WEB-1/2/3/8) and the two follow-up review findings (HIGH-1 in-flight race,
 * HIGH-2 multi-fire unload). queue.ts had ZERO coverage before this — these pin
 * the exact behaviors so they can't silently regress.
 */

import { EventQueue } from './queue';
import { storage } from './storage';
import type { IngestEventPayload } from './types';

const OFFLINE_KEY = 'dl_offline_queue';

function makeEvent(name: string, i = 0): IngestEventPayload {
  // Vary timestamp/data so the dedup (event_name+timestamp+event_data hash) doesn't
  // collapse distinct test events.
  return {
    event_id: `e_${name}_${i}`,
    event_name: name,
    timestamp: 1000 + i,
    event_data: { i },
  } as unknown as IngestEventPayload;
}

describe('EventQueue — data-loss & double-send paths (WEB-1/2/3/8)', () => {
  let queue: EventQueue;
  let originalFetch: any;
  let beacon: jest.Mock;

  beforeEach(() => {
    storage.remove(OFFLINE_KEY);
    originalFetch = (global as any).fetch;
    beacon = jest.fn(() => true);
    (navigator as any).sendBeacon = beacon;
  });

  afterEach(() => {
    if (queue) queue.destroy();
    (global as any).fetch = originalFetch;
    storage.remove(OFFLINE_KEY);
    jest.useRealTimers();
  });

  function newQueue(extra: any = {}): EventQueue {
    return new EventQueue({
      workspaceId: 'ws',
      endpoint: 'https://ingest.test',
      batchSize: 10,
      flushInterval: 5000,
      ...extra,
    });
  }

  test('WEB-8: a failed flush moves events to offline AND removes them from the live queue (single owner)', async () => {
    jest.useFakeTimers();
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('network')));
    // Large flushInterval so the periodic tick doesn't re-drain mid-assertion. Uses the
    // default maxRetries (5), so we drive fake timers through the 5 backoffs.
    queue = newQueue({ flushInterval: 100000 });
    queue.enqueue(makeEvent('pageview', 1));
    expect(queue.getQueueSize()).toBe(1);

    const p = queue.flush();
    await jest.advanceTimersByTimeAsync(40000); // run through the retry backoff
    await p;

    expect(queue.getQueueSize()).toBe(0); // removed from live queue
    expect(queue.getOfflineQueueSize()).toBe(1); // moved to offline as the single owner
  });

  test('WEB-3 / HIGH-1: forceFlush does NOT re-beacon the batch already in-flight in _flush', async () => {
    let resolveFetch!: (v: any) => void;
    (global as any).fetch = jest.fn(() => new Promise((res) => { resolveFetch = res; }));
    queue = newQueue();

    queue.enqueue(makeEvent('pageview', 1)); // non-critical → goes through _flush
    const flushP = queue.flush(); // _flush starts; fetch pending; inFlight set
    await Promise.resolve(); // let _flush reach the await

    queue.forceFlush(); // unload fires mid-flush

    // The in-flight event is excluded (its keepalive fetch carries it) and the offline
    // queue is empty → nothing to beacon → no double-send.
    expect(beacon).not.toHaveBeenCalled();

    resolveFetch({ ok: true, status: 200, statusText: 'OK', headers: { get: () => null } });
    await flushP;
    expect(queue.getQueueSize()).toBe(0);
  });

  test('WEB-3 / HIGH-2: repeated forceFlush (visibilitychange + pagehide + beforeunload) beacons once', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true }));
    queue = newQueue();
    queue.enqueue(makeEvent('pageview', 1));
    queue.enqueue(makeEvent('pageview', 2));

    await queue.forceFlush();
    await queue.forceFlush();
    await queue.forceFlush();

    expect(beacon).toHaveBeenCalledTimes(1); // detached synchronously → re-fires find nothing
    expect(queue.getQueueSize()).toBe(0);
  });

  test('WEB-3: a refused beacon persists the remainder to STORAGE (not in-memory) for the next load', async () => {
    beacon.mockReturnValue(false);
    queue = newQueue();
    queue.enqueue(makeEvent('pageview', 1));
    queue.enqueue(makeEvent('pageview', 2));

    await queue.forceFlush();

    const persisted = storage.get(OFFLINE_KEY, []);
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted.length).toBe(2); // survives to next page load
    expect(queue.getOfflineQueueSize()).toBe(0); // not left in-memory → repeat unload can't re-beacon
  });

  test('WEB-1: a persisted offline queue is drained on construction when online', async () => {
    jest.useFakeTimers();
    storage.set(OFFLINE_KEY, [makeEvent('pageview', 1)]);
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;

    queue = newQueue();
    await jest.advanceTimersByTimeAsync(1100); // on-load drain is setTimeout(…, 1000)

    expect(fetchMock).toHaveBeenCalled();
    expect(queue.getOfflineQueueSize()).toBe(0);
  });

  test('consent gate: setEnabled(false) stops the offline drain (events persisted before opt-out are NOT sent)', async () => {
    jest.useFakeTimers();
    storage.set(OFFLINE_KEY, [makeEvent('purchase', 1)]);
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;

    queue = newQueue();
    queue.setEnabled(false); // opt-out before the on-load drain fires
    await jest.advanceTimersByTimeAsync(1100);

    expect(fetchMock).not.toHaveBeenCalled(); // disabled → no drain of pre-opt-out events
  });

  test('consent gate: a disabled queue neither sends critical events nor flushes', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true }));
    queue = newQueue();
    queue.setEnabled(false);

    queue.enqueue(makeEvent('purchase', 1)); // critical event — would normally send immediately
    await queue.flush();

    expect((global as any).fetch).not.toHaveBeenCalled();
    expect(queue.getQueueSize()).toBe(0);
  });

  test('consent leak: an in-flight flush that FAILS after opt-out does not re-persist PII to storage', async () => {
    jest.useFakeTimers();
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('network')));
    queue = newQueue({ flushInterval: 100000 });

    queue.enqueue(makeEvent('pageview', 1)); // non-critical → goes through _flush
    const p = queue.flush(); // _flush starts; inFlight set; fetch is rejecting+retrying
    // user opts out mid-flight (mirrors optOut: disable + purge)
    queue.setEnabled(false);
    queue.clearOffline();

    await jest.advanceTimersByTimeAsync(40000); // run through retry backoff → _flush catch
    await p;

    // moveToOfflineQueue is gated on `enabled`, so the failed batch is NOT re-persisted.
    expect(queue.getOfflineQueueSize()).toBe(0);
    expect(storage.get(OFFLINE_KEY, [])).toEqual([]);
  });

  test('429: no retry-storm — sends once, parks to offline, honors the Retry-After window', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({
      ok: false, status: 429, statusText: 'Too Many Requests',
      headers: { get: (h: string) => (h === 'Retry-After' ? '1' : null) },
    }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('pageview', 1));
    await queue.flush();
    await new Promise((r) => setTimeout(r, 20));

    // ONE request — not ~6 from fallback + exponential backoff (the old retry-storm).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queue.getOfflineQueueSize()).toBe(1); // parked for later, not dropped

    // Within the Retry-After window, a flush is a no-op (don't hammer the server).
    fetchMock.mockClear();
    await queue.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('config: a negative batchSize is clamped (no infinite-loop / tab hang on drain)', async () => {
    jest.useFakeTimers();
    storage.set(OFFLINE_KEY, [makeEvent('pageview', 1)]);
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;

    // batchSize:-1 used to make processOfflineQueue's splice(0,-1) loop forever (frozen
    // tab). If the clamp regressed, this test would HANG (jest timeout) instead of pass.
    queue = newQueue({ batchSize: -1 });
    await jest.advanceTimersByTimeAsync(1100); // on-load drain

    expect(fetchMock).toHaveBeenCalled();
    expect(queue.getOfflineQueueSize()).toBe(0);
  });
});
