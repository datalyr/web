/**
 * Identity before critical events (1.9.14).
 *
 * A critical event (purchase / signup / lead / …) skips the batch and is sent at once.
 * An `$identify` tracked just before it used to wait in the live queue for the flush
 * timer, so the critical event reached ingest first and a conversion rule forwarded it
 * to Meta without the email. Now the queued events up to and including the last
 * identity event go in the same batch, ahead of the critical event.
 */

import { EventQueue } from './queue';
import { storage } from './storage';
import type { IngestEventPayload } from './types';

const OFFLINE_KEY = 'dl_offline_queue';

function makeEvent(name: string, i = 0): IngestEventPayload {
  return {
    event_id: `e_${name}_${i}`,
    event_name: name,
    timestamp: 1000 + i,
    event_data: { i },
  } as unknown as IngestEventPayload;
}

/** Event names of each POSTed batch, in send order. */
function sentBatches(fetchMock: jest.Mock): string[][] {
  return fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(init.body).events.map((e: any) => e.event_name)
  );
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('EventQueue — identity events leave no later than a critical event', () => {
  let queue: EventQueue;
  let originalFetch: any;

  beforeEach(() => {
    storage.remove(OFFLINE_KEY);
    originalFetch = (global as any).fetch;
    (navigator as any).sendBeacon = jest.fn(() => true);
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
      flushInterval: 100000, // keep the periodic tick out of the way
      ...extra,
    });
  }

  test('a queued $identify goes in the same batch as the critical event, ahead of it', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('$identify', 1)); // non-critical → waits in the live queue
    expect(fetchMock).not.toHaveBeenCalled();
    queue.enqueue(makeEvent('signup', 2)); // critical

    expect(sentBatches(fetchMock)).toEqual([['$identify', 'signup']]);
    expect(queue.getQueueSize()).toBe(0);

    await settle();
    expect(queue.getOfflineQueueSize()).toBe(0);
    expect(storage.get(OFFLINE_KEY, [])).toEqual([]);
  });

  test('$alias counts as an identity event too', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('$alias', 1));
    queue.enqueue(makeEvent('purchase', 2));

    expect(sentBatches(fetchMock)).toEqual([['$alias', 'purchase']]);
  });

  test('events queued before the last identity event keep their order; later ones stay queued', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('pageview', 1));
    queue.enqueue(makeEvent('$identify', 2));
    queue.enqueue(makeEvent('button_click', 3));
    queue.enqueue(makeEvent('lead', 4)); // critical

    expect(sentBatches(fetchMock)).toEqual([['pageview', '$identify', 'lead']]);
    // Not an identity dependency: left for the normal flush, as before.
    expect(queue.getQueueSize()).toBe(1);

    await queue.flush();
    expect(sentBatches(fetchMock)[1]).toEqual(['button_click']);
  });

  test('critical event with an empty queue: sent alone, persisted before the send, removed on delivery (unchanged)', async () => {
    let resolveFetch!: (v: any) => void;
    const fetchMock = jest.fn(() => new Promise((res) => { resolveFetch = res; }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('purchase', 1));

    expect(sentBatches(fetchMock)).toEqual([['purchase']]);
    expect(queue.getOfflineQueueSize()).toBe(1);
    expect(storage.get(OFFLINE_KEY, []).map((e: any) => e.event_name)).toEqual(['purchase']);

    resolveFetch({ ok: true });
    await settle();
    expect(queue.getOfflineQueueSize()).toBe(0);
    expect(storage.get(OFFLINE_KEY, [])).toEqual([]);
  });

  test('a queue with no identity event is not touched by a critical event (unchanged)', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('pageview', 1));
    queue.enqueue(makeEvent('purchase', 2));

    expect(sentBatches(fetchMock)).toEqual([['purchase']]);
    expect(queue.getQueueSize()).toBe(1);
  });

  test('the identity events are persisted with the critical event before the send (unload-safe)', () => {
    (global as any).fetch = jest.fn(() => new Promise(() => {})); // never settles → mid-send
    queue = newQueue();

    queue.enqueue(makeEvent('$identify', 1));
    queue.enqueue(makeEvent('signup', 2));

    expect(storage.get(OFFLINE_KEY, []).map((e: any) => e.event_name)).toEqual(['$identify', 'signup']);
  });

  test('a failed send keeps both events, in order, in the offline queue for retry', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn(() => Promise.reject(new Error('network')));
    (global as any).fetch = fetchMock;
    queue = newQueue({ maxRetries: 0 });

    queue.enqueue(makeEvent('$identify', 1));
    queue.enqueue(makeEvent('signup', 2));
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queue.getQueueSize()).toBe(0);
    expect(queue.getOfflineQueueSize()).toBe(2);
    expect(storage.get(OFFLINE_KEY, []).map((e: any) => e.event_name)).toEqual(['$identify', 'signup']);

    // The next drain retries them together, identity first.
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true }) as any);
    await jest.advanceTimersByTimeAsync(100000); // periodic tick → processOfflineQueue
    expect(sentBatches(fetchMock)[1]).toEqual(['$identify', 'signup']);
    expect(queue.getOfflineQueueSize()).toBe(0);
  });

  test('a permanent 4xx drops the identity events with the critical event (not parked)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = jest.fn(() => Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('$identify', 1));
    queue.enqueue(makeEvent('signup', 2));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(queue.getQueueSize()).toBe(0);
    expect(queue.getOfflineQueueSize()).toBe(0);
    expect(storage.get(OFFLINE_KEY, [])).toEqual([]);
  });

  test('an $identify already in flight in _flush is not taken or re-sent', async () => {
    const resolvers: Array<(v: any) => void> = [];
    const fetchMock = jest.fn(() => new Promise((res) => { resolvers.push(res); }));
    (global as any).fetch = fetchMock;
    queue = newQueue();

    queue.enqueue(makeEvent('$identify', 1));
    const flushP = queue.flush(); // [$identify] is now in flight
    queue.enqueue(makeEvent('$alias', 2)); // queued behind the in-flight batch
    queue.enqueue(makeEvent('purchase', 3));

    expect(sentBatches(fetchMock)).toEqual([['$identify'], ['$alias', 'purchase']]);
    expect(queue.getQueueSize()).toBe(1); // the in-flight $identify, removed when its send settles

    resolvers.forEach((r) => r({ ok: true }));
    await flushP;
    await settle();
    expect(queue.getQueueSize()).toBe(0);
    expect(queue.getOfflineQueueSize()).toBe(0);
  });
});

// End to end through the SDK: identify() then a critical track(), as roasOS does
// (identify(userId, { email }) then track('signup_completed') with it marked critical).
type DatalyrSdkModule = typeof import('./index');

describe('SDK — identify() then a critical track()', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).datalyr;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  test('$identify is on the wire no later than the critical event, ahead of it', async () => {
    const fetchMock = jest.fn((_url: string, _init: any) => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    (global as any).fetch = fetchMock;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    let sdk!: DatalyrSdkModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sdk = require('./index') as DatalyrSdkModule;
    });
    const instance = sdk.createDatalyrInstance();
    instance.init({
      workspaceId: 'ws-identify-order',
      endpoint: 'https://ingest.test',
      enableContainer: false,
      enableFingerprinting: false,
      enablePerformanceTracking: false,
      trackPageViews: false,
      trackSPA: false,
      stripePaymentLinks: false,
      criticalEvents: ['signup_completed'],
    } as any);
    await instance.ready();

    instance.identify('user_1', { email: 'a@example.com' });
    instance.track('signup_completed');

    const ingestBatches = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith('https://ingest.test'))
      .map(([, init]) => JSON.parse(init.body).events.map((e: any) => e.event_name));
    const flat = ingestBatches.flat();
    expect(flat).toContain('signup_completed');
    expect(flat.indexOf('$identify')).toBeGreaterThanOrEqual(0);
    expect(flat.indexOf('$identify')).toBeLessThan(flat.indexOf('signup_completed'));
    // Before the fix the critical event went out alone and $identify waited 5 s.
    expect(ingestBatches.find((b) => b.includes('signup_completed'))).toEqual(['$identify', 'signup_completed']);

    instance.destroy();
  });
});
