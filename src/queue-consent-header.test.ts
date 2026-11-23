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

describe('EventQueue edge visitor adoption (C19, edgeCookieV2)', () => {
  const P = 'anon_0b815a3e-6f9d-4c2e-8a7b-1c3d5e7f9a0b';
  const EDGE = 'anon_11111111-2222-4333-8444-555555555555';
  let queue: EventQueue | undefined;
  let fetchMock: jest.Mock;
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    storage.remove('dl_offline_queue');
    fetchMock = jest.fn(() => Promise.resolve({
      ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, visitor_id: EDGE }),
    }));
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    queue?.destroy();
    queue = undefined;
    (global as any).fetch = originalFetch;
    storage.remove('dl_offline_queue');
  });

  function event(i: number, id: string): IngestEventPayload {
    return { ...makeEvent(i), visitor_id: id, anonymous_id: id, distinct_id: id, canonical_id: id, session_id: 's' } as unknown as IngestEventPayload;
  }

  function sentEvents(call = 0): any[] {
    return JSON.parse(fetchMock.mock.calls[call][1].body).events;
  }

  test('pending id: the first collect names no visitor, and the edge answer is adopted', async () => {
    const adopt = jest.fn();
    let pending: string | null = P;
    let replaced: { from: string; to: string } | null = null;
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://t.shop.example', flushInterval: 100000 });
    queue.setEdgeVisitor({ pending: () => pending, replaced: () => replaced, adopt: (id) => { adopt(id); pending = null; replaced = { from: P, to: id }; }, giveUp: () => { pending = null; } });
    queue.enqueue(event(1, P));
    await queue.flush();
    const [first] = sentEvents();
    for (const f of ['visitor_id', 'anonymous_id', 'distinct_id', 'canonical_id']) expect(first).not.toHaveProperty(f);
    expect(first.session_id).toBe('s');
    expect(adopt).toHaveBeenCalledWith(EDGE);
    // An event queued with the old id before the adoption goes out with the edge's id.
    queue.enqueue(event(2, P));
    await queue.flush();
    expect(sentEvents(1)[0].visitor_id).toBe(EDGE);
    expect(sentEvents(1)[0].anonymous_id).toBe(EDGE);
  });

  test('setting off (hooks answer null) or DATALYR endpoint: payload untouched, nothing adopted', async () => {
    const adopt = jest.fn();
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://t.shop.example', flushInterval: 100000 });
    queue.setEdgeVisitor({ pending: () => null, replaced: () => null, adopt, giveUp: jest.fn() });
    queue.enqueue(event(1, P));
    await queue.flush();
    expect(sentEvents()[0].visitor_id).toBe(P);
    queue.destroy();
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://ingest.datalyr.com', flushInterval: 100000 });
    queue.setEdgeVisitor({ pending: () => P, replaced: () => null, adopt, giveUp: jest.fn() });
    queue.enqueue(event(2, P));
    await queue.flush();
    expect(sentEvents(1)[0].visitor_id).toBe(P);
    expect(adopt).not.toHaveBeenCalled();
  });

  function hooks() {
    const state = { pending: P as string | null, replaced: null as { from: string; to: string } | null };
    const h = {
      pending: () => state.pending,
      replaced: () => state.replaced,
      adopt: jest.fn((id: string) => { state.pending = null; state.replaced = { from: P, to: id }; }),
      giveUp: jest.fn(() => { state.pending = null; }),
    };
    return { state, h };
  }

  test('only ONE id-less request in flight: a critical send waits for the first answer', async () => {
    let answer!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, visitor_id: EDGE }) });
    }));
    const { h } = hooks();
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://t.shop.example', flushInterval: 100000 });
    queue.setEdgeVisitor(h);
    queue.enqueue(event(1, P));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.enqueue({ ...event(2, P), event_name: 'purchase' } as IngestEventPayload); // critical: sent at once
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the critical send is waiting
    answer();
    await flushing;
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Whichever went first went without the id; the other waited and carries the edge's.
    for (const e of sentEvents(0)) expect(e).not.toHaveProperty('visitor_id');
    for (const e of sentEvents(1)) expect(e.visitor_id).toBe(EDGE);
    const names = [...sentEvents(0), ...sentEvents(1)].map((e: any) => e.event_name).sort();
    expect(names).toEqual(['pageview', 'purchase']);
    expect(h.adopt).toHaveBeenCalledTimes(1);
  });

  test('an answer with no visitor_id (old edge, switch off): stop stripping, the local id goes', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true }) }));
    const { h } = hooks();
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://t.shop.example', flushInterval: 100000 });
    queue.setEdgeVisitor(h);
    queue.enqueue(event(1, P));
    await queue.flush();
    expect(h.giveUp).toHaveBeenCalled();
    queue.enqueue(event(2, P));
    await queue.flush();
    expect(sentEvents(1)[0].visitor_id).toBe(P);
  });

  test('the minted id inside event_data ($identify) is stripped while pending, replaced after', async () => {
    const { h } = hooks();
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://t.shop.example', flushInterval: 100000 });
    queue.setEdgeVisitor(h);
    queue.enqueue({ ...event(1, P), event_name: '$identify', event_data: { anonymous_id: P, traits: { previous_id: P }, plan: 'pro' } } as unknown as IngestEventPayload);
    await queue.flush();
    const sent = sentEvents(0)[0];
    expect(sent.event_data).toEqual({ traits: {}, plan: 'pro' });
    queue.enqueue({ ...event(2, P), event_name: '$alias', event_data: { previousId: P } } as unknown as IngestEventPayload);
    await queue.flush();
    expect(sentEvents(1)[0].event_data).toEqual({ previousId: EDGE });
  });

  test('a beacon while the id is pending goes without it too', async () => {
    const beacon = jest.fn(() => true);
    (navigator as any).sendBeacon = beacon;
    const { h } = hooks();
    queue = new EventQueue({ workspaceId: 'ws', endpoint: 'https://t.shop.example', flushInterval: 100000 });
    queue.setEdgeVisitor(h);
    queue.enqueue(event(1, P));
    await queue.forceFlush(true);
    const blob = (beacon.mock.calls[0] as any[])[1] as Blob;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const body = JSON.parse(text);
    expect(body.events[0]).not.toHaveProperty('visitor_id');
    expect(body.events[0]).not.toHaveProperty('anonymous_id');
  });
});
