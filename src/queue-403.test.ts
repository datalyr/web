// WEB-23 / WEB-24 — a 403 must not silently destroy the batch.
//
// FSR-55 classed every 4xx except 408 as PERMANENT and dropped the batch. That is
// right for 400 (malformed) and 401 (bad key), but a 403 from ingest means
// "origin not allowed" — server *configuration* state, which changes. On
// 2026-07-13 an allowed_origins regression 403'd three workspaces; the config was
// fixed 11 days later, and every event sent in between had already been dropped
// on the floor behind a debug-gated log line.

export {};

import { EventQueue } from './queue';
import type { IngestEventPayload } from './types';

function makeEvent(name = 'pageview'): IngestEventPayload {
  return {
    workspace_id: 'ws_test',
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    event_name: name,
    event_data: {},
    source: 'web',
    timestamp: new Date().toISOString(),
  } as IngestEventPayload;
}

function makeQueue(overrides: Record<string, any> = {}) {
  return new EventQueue({
    workspaceId: 'ws_test',
    endpoint: 'https://ingest.example.com',
    batchSize: 1,
    flushInterval: 3_600_000, // never fire on its own during a test
    debug: false,
    ...overrides,
  });
}

/** Respond to every send with `status`, counting attempts. */
function stubFetch(status: number) {
  const calls = { n: 0 };
  (globalThis as any).fetch = jest.fn(async () => {
    calls.n += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: { get: () => null },
      json: async () => ({}),
    };
  });
  return calls;
}

describe('WEB-23 — 403 parks events instead of dropping them', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    localStorage.clear();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  it('keeps the events on a 403 rather than discarding them', async () => {
    stubFetch(403);
    const q = makeQueue();

    q.enqueue(makeEvent());
    await q.flush();

    // Survived: parked offline, nothing counted as dropped.
    expect(q.getStats().droppedEvents).toBe(0);
    expect(q.getOfflineQueueSize()).toBeGreaterThan(0);
    q.destroy();
  });

  it('backs off after a 403 instead of hammering the rejecting origin', async () => {
    // FSR-55's concern was real — a rejected origin must not be retried in a
    // tight loop. Parking must come WITH a backoff window.
    const calls = stubFetch(403);
    const q = makeQueue();

    q.enqueue(makeEvent());
    await q.flush();
    const afterFirst = calls.n;

    await q.flush();
    await q.flush();

    expect(calls.n).toBe(afterFirst);
    expect(q.getStats().backoffUntil).toBeGreaterThan(Date.now());
    q.destroy();
  });

  it('still drops a genuinely permanent 400, and counts it', async () => {
    // The narrowing must not neuter FSR-55: a malformed payload will never be
    // accepted, so parking it forever would head-of-line-block the queue.
    stubFetch(400);
    const q = makeQueue();

    q.enqueue(makeEvent());
    await q.flush();

    expect(q.getStats().droppedEvents).toBe(1);
    expect(q.getStats().lastDropStatus).toBe(400);
    expect(q.getOfflineQueueSize()).toBe(0);
    q.destroy();
  });

  it('still drops a 401', async () => {
    stubFetch(401);
    const q = makeQueue();

    q.enqueue(makeEvent());
    await q.flush();

    expect(q.getStats().droppedEvents).toBe(1);
    expect(q.getStats().lastDropStatus).toBe(401);
    q.destroy();
  });

  it('surfaces a drop without debug mode', async () => {
    // The 2026-07-13 outage was invisible because the only signal was a
    // debug-gated log. A drop is data loss and must warn unconditionally.
    stubFetch(400);
    const q = makeQueue({ debug: false });

    q.enqueue(makeEvent());
    await q.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped'));
    q.destroy();
  });

  it('a critical event survives a 403 too', async () => {
    // Critical events (purchase/signup/…) bypass batching and take their own
    // send path, which also branched on PermanentError.
    stubFetch(403);
    const q = makeQueue();

    q.enqueue(makeEvent('purchase'));
    await new Promise((r) => setTimeout(r, 0));

    expect(q.getStats().droppedEvents).toBe(0);
    expect(q.getOfflineQueueSize()).toBeGreaterThan(0);
    q.destroy();
  });
});

describe('WEB-24 — offline-queue lock never loses a batch', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  it('buffers rather than discarding when the lock is held', async () => {
    // Not reachable today — the locked section is fully synchronous, so the flag
    // can never be seen set on entry. This asserts the INVARIANT holds anyway,
    // because the path is one `await` (IndexedDB, encrypted storage) away from
    // becoming live silent data loss.
    const q: any = makeQueue();
    const events = [makeEvent(), makeEvent()];

    q.offlineQueueLock = true;
    q.moveToOfflineQueue(events);

    expect(q.getOfflineQueueSize()).toBe(2);
    q.destroy();
  });
});
