// 1.9.15 (FX-083 piece 1): the offline backlog keeps unsent events when the page cannot
// reach DATALYR. services-b-127 (tabs overwrite each other, a refused save is ignored,
// bfcache restores an empty queue, the cap drops purchases), services-b-135 (no send
// timeout), services-b-125 (413 drops a batch), plus `dropped_since_last`.

export {};

import { EventQueue } from './queue';
import { storage } from './storage';
import type { IngestEventPayload } from './types';

const OFFLINE_KEY = 'dl_offline_queue';

let seq = 0;
function makeEvent(name = 'pageview'): IngestEventPayload {
  seq += 1;
  return {
    workspace_id: 'ws_test',
    event_id: `evt_${seq}_${Math.random().toString(36).slice(2)}`,
    event_name: name,
    event_data: { n: seq },
    source: 'web',
    timestamp: new Date(Date.now() + seq).toISOString(),
  } as unknown as IngestEventPayload;
}

function makeQueue(overrides: Record<string, any> = {}) {
  return new EventQueue({
    workspaceId: 'ws_test',
    endpoint: 'https://ingest.example.com',
    batchSize: 10,
    flushInterval: 3_600_000,
    maxRetries: 0,
    retryDelay: 0,
    debug: false,
    ...overrides,
  });
}

type Sent = { events: IngestEventPayload[]; body: any };

/** fetch stub: `answer(events)` returns the status for that request. */
function stubFetch(answer: (events: IngestEventPayload[]) => number) {
  const sent: Sent[] = [];
  (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ events: body.events, body });
    const status = answer(body.events);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: { get: () => null },
      json: async () => ({}),
    };
  });
  return sent;
}

function stored(): IngestEventPayload[] {
  const raw = localStorage.getItem('dl_' + OFFLINE_KEY);
  return raw ? JSON.parse(raw) : [];
}

describe('FX-083 offline backlog (web SDK 1.9.15)', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
  });

  test('two tabs parking events keep both tabs\' events in storage (merge on save)', async () => {
    stubFetch(() => 500);
    const tabA = makeQueue();
    const tabB = makeQueue();
    const a = makeEvent();
    const b = makeEvent();

    tabA.enqueue(a);
    await tabA.flush();
    tabB.enqueue(b);
    await tabB.flush();

    const ids = stored().map(e => e.event_id);
    expect(ids).toEqual(expect.arrayContaining([a.event_id, b.event_id]));
    tabA.destroy();
    tabB.destroy();
  });

  test('a tab that delivers its backlog removes only its own events, not another tab\'s', async () => {
    let status = 500;
    stubFetch(() => status);
    const tabA = makeQueue();
    const tabB = makeQueue();
    const a = makeEvent();
    const b = makeEvent();
    tabA.enqueue(a);
    await tabA.flush();
    tabB.enqueue(b);
    await tabB.flush();

    status = 200;
    await tabA.forceFlush(false); // response-checked drain of tab A's backlog

    expect(stored().map(e => e.event_id)).toEqual([b.event_id]);
    tabA.destroy();
    tabB.destroy();
  });

  test('a delivered critical event is not written back by a later save', async () => {
    stubFetch(() => 200);
    const q = makeQueue();
    const purchase = makeEvent('purchase');
    q.enqueue(purchase);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(stored()).toEqual([]);

    // An older copy left by another tab's save must not resurrect it.
    localStorage.setItem('dl_' + OFFLINE_KEY, JSON.stringify([purchase]));
    (globalThis as any).fetch = jest.fn(async () => ({ ok: false, status: 500, statusText: '', headers: { get: () => null } }));
    const pv = makeEvent();
    q.enqueue(pv);
    await q.flush();
    expect(stored().map(e => e.event_id)).toEqual([pv.event_id]);
    q.destroy();
  });

  test('the cap drops the oldest ordinary events first and keeps the purchase', async () => {
    stubFetch(() => 500);
    const q = makeQueue({ maxOfflineQueueSize: 3, batchSize: 1 });
    const purchase = makeEvent('purchase');
    q.enqueue(purchase);
    await new Promise(r => setTimeout(r, 0));
    for (let i = 0; i < 3; i++) {
      q.enqueue(makeEvent());
      await q.flush();
    }

    const names = stored().map(e => e.event_name);
    expect(names).toHaveLength(3);
    expect(names).toContain('purchase');
    expect(q.getStats().droppedEvents).toBe(1);
    q.destroy();
  });

  test('a refused save (storage full) is acted on: critical events are saved alone and reported', async () => {
    stubFetch(() => 500);
    const realSet = storage.set.bind(storage);
    jest.spyOn(storage, 'set').mockImplementation((key: string, value: any) => {
      if (key === OFFLINE_KEY && Array.isArray(value) && value.some((e: any) => e.event_name !== 'purchase')) {
        return false;
      }
      return realSet(key, value);
    });
    const q = makeQueue({ batchSize: 1 });
    const purchase = makeEvent('purchase');
    q.enqueue(purchase);
    await new Promise(r => setTimeout(r, 0));
    q.enqueue(makeEvent());
    await q.flush();

    expect(stored().map(e => e.event_id)).toEqual([purchase.event_id]);
    expect(q.getStats().offlinePersisted).toBe(false);
    expect(q.getOfflineQueueSize()).toBe(2); // still held in memory and sent this visit
    q.destroy();
  });

  test('a page restored from the back/forward cache reloads the persisted backlog', async () => {
    stubFetch(() => 500);
    const q = makeQueue();
    q.enqueue(makeEvent());
    (navigator as any).sendBeacon = jest.fn(() => false);
    await q.forceFlush(true); // pagehide: persisted, memory emptied
    expect(q.getQueueSize() + q.getOfflineQueueSize()).toBe(0);

    const ev = new Event('pageshow');
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);

    expect(q.getOfflineQueueSize()).toBe(1);
    q.destroy();
    delete (navigator as any).sendBeacon;
  });

  test('a send that never answers is aborted after 15 s and the events are parked', async () => {
    jest.useFakeTimers();
    (globalThis as any).fetch = jest.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const q = makeQueue();
    q.enqueue(makeEvent());
    const flushing = q.flush();
    await jest.advanceTimersByTimeAsync(15_000);
    await flushing;

    expect(q.getQueueSize()).toBe(0);
    expect(q.getOfflineQueueSize()).toBe(1);
    q.destroy();
  });

  test('a 413 splits the batch in halves instead of dropping it', async () => {
    const sent = stubFetch(events => (events.length > 2 ? 413 : 200));
    const q = makeQueue({ batchSize: 4 });
    const evs = [makeEvent(), makeEvent(), makeEvent(), makeEvent()];
    evs.forEach(e => q.enqueue(e));
    await q.flush();

    const delivered = sent.filter(s => s.events.length <= 2).flatMap(s => s.events.map(e => e.event_id));
    expect(delivered.sort()).toEqual(evs.map(e => e.event_id).sort());
    expect(q.getStats().droppedEvents).toBe(0);
    expect(q.getOfflineQueueSize()).toBe(0);
    q.destroy();
  });

  test('after a 413 split, one oversized event is dropped and counted; the rest are delivered', async () => {
    let poison = '';
    const sent = stubFetch(events =>
      events.length > 1 ? 413 : events[0].event_id === poison ? 413 : 200
    );
    const q = makeQueue({ batchSize: 3 });
    const evs = [makeEvent(), makeEvent(), makeEvent()];
    poison = evs[1].event_id;
    evs.forEach(e => q.enqueue(e));
    await q.flush();

    const ok = sent.filter(s => s.events.length === 1 && s.events[0].event_id !== poison);
    expect(ok.map(s => s.events[0].event_id).sort()).toEqual([evs[0].event_id, evs[2].event_id].sort());
    expect(q.getStats().droppedEvents).toBe(1);
    expect(q.getStats().lastDropStatus).toBe(413);
    q.destroy();
  });

  test('dropped events are reported once as dropped_since_last on the next delivered batch', async () => {
    let status = 400;
    const sent = stubFetch(() => status);
    const q = makeQueue({ batchSize: 1 });
    q.enqueue(makeEvent());
    await q.flush(); // permanently rejected, dropped

    status = 200;
    q.enqueue(makeEvent());
    await q.flush();
    q.enqueue(makeEvent());
    await q.flush();

    expect(sent[0].body.dropped_since_last).toBeUndefined();
    expect(sent[1].body.dropped_since_last).toBe(1);
    expect(sent[2].body.dropped_since_last).toBeUndefined();
    expect(q.getStats().droppedSinceLastReport).toBe(0);
    q.destroy();
  });

  test('a drop not yet reported survives a page load', async () => {
    let status = 400;
    const sent = stubFetch(() => status);
    const first = makeQueue({ batchSize: 1 });
    first.enqueue(makeEvent());
    await first.flush();
    first.destroy();

    status = 200;
    const next = makeQueue({ batchSize: 1 });
    next.enqueue(makeEvent());
    await next.flush();
    expect(sent[sent.length - 1].body.dropped_since_last).toBe(1);
    next.destroy();
  });

  test('the stored backlog stays a plain array of events (an older script can read it after a rollback)', async () => {
    stubFetch(() => 500);
    const q = makeQueue();
    const e = makeEvent();
    q.enqueue(e);
    await q.flush();
    const raw = JSON.parse(localStorage.getItem('dl_' + OFFLINE_KEY) || 'null');
    expect(Array.isArray(raw)).toBe(true);
    expect(raw[0]).toEqual(e);
    q.destroy();
  });
});
