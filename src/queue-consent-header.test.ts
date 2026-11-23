/**
 * FX-083 C18: X-DL-Consent on first-party event requests, dl_consent= on their beacons.
 * Behind the consentHeader setting (off): with no signal the requests are unchanged.
 */
import { EventQueue } from './queue';
import { storage } from './storage';
import type { IngestEventPayload } from './types';

function makeEvent(i: number): IngestEventPayload {
  return { event_id: `e_${i}`, event_name: 'pageview', timestamp: 1000 + i, event_data: { i } } as unknown as IngestEventPayload;
}

describe('EventQueue consent signal (C18)', () => {
  let queue: EventQueue | undefined;
  let fetchMock: jest.Mock;
  let beacon: jest.Mock;
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    storage.remove('dl_offline_queue');
    fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }));
    (global as any).fetch = fetchMock;
    beacon = jest.fn(() => true);
    (navigator as any).sendBeacon = beacon;
  });

  afterEach(() => {
    queue?.destroy();
    queue = undefined;
    (global as any).fetch = originalFetch;
    storage.remove('dl_offline_queue');
  });

  function newQueue(endpoint: string, signal?: () => string | null): EventQueue {
    const q = new EventQueue({ workspaceId: 'ws', endpoint, batchSize: 10, flushInterval: 100000 });
    if (signal) q.setConsentSignal(signal);
    q.enqueue(makeEvent(1));
    return q;
  }

  test('setting off (no signal, or null): headers and beacon URL exactly as before', async () => {
    for (const signal of [undefined, () => null]) {
      queue = newQueue('https://t.shop.example', signal);
      await queue.flush();
      expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', 'X-Batch-Size': '1' });
      queue.enqueue(makeEvent(2));
      await queue.forceFlush(true);
      expect(beacon.mock.calls[0][0]).toBe('https://t.shop.example');
      queue.destroy();
      fetchMock.mockClear();
      beacon.mockClear();
    }
  });

  test('on, first-party endpoint: X-DL-Consent header and dl_consent on the beacon', async () => {
    let value = 'granted';
    queue = newQueue('https://t.shop.example', () => value);
    await queue.flush();
    expect(fetchMock.mock.calls[0][1].headers['X-DL-Consent']).toBe('granted');
    value = 'denied';
    queue.enqueue(makeEvent(2));
    await queue.forceFlush(true);
    expect(new URL(beacon.mock.calls[0][0]).searchParams.get('dl_consent')).toBe('denied');
  });

  test('on, DATALYR endpoint: nothing added (only first-party edge requests carry it)', async () => {
    queue = newQueue('https://ingest.datalyr.com', () => 'granted');
    await queue.flush();
    expect(fetchMock.mock.calls[0][1].headers['X-DL-Consent']).toBeUndefined();
    queue.enqueue(makeEvent(2));
    await queue.forceFlush(true);
    expect(beacon.mock.calls[0][0]).toBe('https://ingest.datalyr.com');
  });
});
