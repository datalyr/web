/**
 * Session replay recorder (dl.replay.<v>.js). rrweb itself is mocked: what is tested is
 * our side of it — options passed to record(), masking, the chunk envelope and its
 * transport, hidden/unload parking, same-session-only restore, discard on stop, idle
 * pause, the mutation throttle and our Custom events.
 */
import { gunzipSync, strFromU8 } from 'fflate';

const mockRrweb: {
  emit?: (event: any, isCheckout?: boolean) => void;
  opts?: any;
  stop: jest.Mock;
  custom: jest.Mock;
  full: jest.Mock;
} = { stop: jest.fn(), custom: jest.fn(), full: jest.fn() };

jest.mock('@rrweb/record', () => {
  const record: any = jest.fn((opts: any) => {
    mockRrweb.opts = opts;
    mockRrweb.emit = opts.emit;
    return mockRrweb.stop;
  });
  record.addCustomEvent = (tag: string, payload: unknown) => {
    mockRrweb.custom(tag, payload);
    mockRrweb.emit?.({ type: 5, data: { tag, payload }, timestamp: Date.now() });
  };
  record.takeFullSnapshot = (isCheckout?: boolean) => mockRrweb.full(isCheckout);
  return { record };
});

import {
  FLUSH_INTERVAL_MS, IDLE_PAUSE_MS, KEEPALIVE_MAX_BYTES, PARK_KEY, Recorder, maskText,
} from './replay/recorder';

const flushPromises = () => new Promise(resolve => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));

let sessionId = 'sess_a';
const ctx = {
  workspaceId: 'ws_pub_1',
  sdkVersion: '1.8.0',
  endpoint: 'https://replay.datalyr.com/replay',
  getSessionId: () => sessionId,
  getVisitorId: () => 'anon_v1',
};

function decode(call: any[]): any {
  const body = call[1].body as Uint8Array;
  return JSON.parse(strFromU8(gunzipSync(body)));
}

const inc = (source: number, extra: Record<string, unknown> = {}) => ({ type: 3, data: { source, ...extra }, timestamp: Date.now() });

describe('replay recorder', () => {
  let fetchMock: jest.Mock;
  let recorder: Recorder;

  beforeEach(() => {
    jest.useFakeTimers();
    sessionId = 'sess_a';
    sessionStorage.clear();
    mockRrweb.stop.mockClear();
    mockRrweb.custom.mockClear();
    mockRrweb.full.mockClear();
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    (global as any).fetch = fetchMock;
    recorder = new Recorder();
  });

  afterEach(() => {
    recorder.stop(true);
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  test('registers itself as window.DatalyrReplay', () => {
    expect((window as any).DatalyrReplay).toBeInstanceOf(Recorder);
  });

  test('record() options: inputs + all text masked, block selector, slim DOM, no canvas/fonts/images/iframes', () => {
    recorder.start(ctx);
    expect(mockRrweb.opts).toEqual(expect.objectContaining({
      maskAllInputs: true,
      maskInputOptions: { password: true },
      maskTextSelector: '*',
      maskTextFn: maskText,
      blockSelector: '[data-dl-block]',
      slimDOMOptions: 'all',
      inlineStylesheet: true,
      inlineImages: false,
      collectFonts: false,
      recordCanvas: false,
      recordCrossOriginIframes: false,
      checkoutEveryNms: 300_000,
    }));
    expect(mockRrweb.opts.sampling).toEqual(expect.objectContaining({ scroll: 150, input: 'last' }));
    // No console plugin.
    expect(mockRrweb.opts.plugins).toBeUndefined();
  });

  test('text masking: everything masked except interactive text; data-dl-mask wins inside it', () => {
    document.body.innerHTML = `
      <p id="p">Jane Doe, 1 High St</p>
      <button id="b">Add to bag</button>
      <a id="a" href="#"><span id="as">Checkout</span></a>
      <label id="l">Email</label>
      <div role="button" id="r">Buy now</div>
      <details><summary id="s">Sizes</summary></details>
      <div data-dl-unmask><h2 id="u">Free shipping</h2></div>
      <button><span data-dl-mask id="m">Hi Jane</span></button>`;
    const el = (id: string) => document.getElementById(id) as HTMLElement;
    expect(maskText('Jane Doe, 1 High St', el('p'))).toBe('**** **** * **** **');
    expect(maskText('Add to bag', el('b'))).toBe('Add to bag');
    expect(maskText('Checkout', el('as'))).toBe('Checkout');
    expect(maskText('Email', el('l'))).toBe('Email');
    expect(maskText('Buy now', el('r'))).toBe('Buy now');
    expect(maskText('Sizes', el('s'))).toBe('Sizes');
    expect(maskText('Free shipping', el('u'))).toBe('Free shipping');
    expect(maskText('Hi Jane', el('m'))).toBe('** ****');
    expect(maskText('orphan', null)).toBe('******');
  });

  test('a chunk every 10 s: gzip, text/plain, ?enc=gzip, envelope per the contract', async () => {
    recorder.start(ctx);
    mockRrweb.emit!({ type: 4, data: { href: 'https://shop.test/' }, timestamp: 1 });
    mockRrweb.emit!({ type: 2, data: { node: {} }, timestamp: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://replay.datalyr.com/replay?enc=gzip');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'omit', keepalive: false, headers: { 'Content-Type': 'text/plain' } }));
    const env = decode(fetchMock.mock.calls[0]);
    expect(Object.keys(env)).toEqual(['w', 's', 'v', 'p', 'q', 'sv', 'rb', 'e']);
    expect(env).toEqual(expect.objectContaining({ w: 'ws_pub_1', s: 'sess_a', v: 'anon_v1', q: 0, sv: '1.8.0' }));
    expect(env.p).toMatch(/^[0-9a-f-]{36}$/);
    // ph custom event from start(), then meta + full snapshot.
    expect(env.e.map((e: any) => e.type)).toEqual([5, 4, 2]);
    expect(env.rb).toBe(Buffer.byteLength(JSON.stringify(env.e)));

    mockRrweb.emit!(inc(2));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    const second = decode(fetchMock.mock.calls[1]);
    expect(second.q).toBe(1);
    expect(second.p).toBe(env.p);
  });

  test('256 KB of raw events flushes without waiting for the timer', async () => {
    recorder.start(ctx);
    mockRrweb.emit!(inc(2, { pad: 'x'.repeat(260 * 1024) }));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('custom events: track/url/vis/ph/err as rrweb type 5 with tag dl', async () => {
    recorder.start(ctx);
    recorder.event('track', { name: 'add_to_cart', value: 20 });
    recorder.event('url', { href: 'https://shop.test/cart' });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(Object.assign(new Event('error'), { message: 'x'.repeat(1000) }));
    expect(mockRrweb.custom).toHaveBeenCalledWith('dl', { k: 'ph', h: expect.any(Number) });
    expect(mockRrweb.custom).toHaveBeenCalledWith('dl', { k: 'track', name: 'add_to_cart', value: 20 });
    expect(mockRrweb.custom).toHaveBeenCalledWith('dl', { k: 'url', href: 'https://shop.test/cart' });
    expect(mockRrweb.custom).toHaveBeenCalledWith('dl', { k: 'vis', hidden: false });
    const err = mockRrweb.custom.mock.calls.find(c => c[1].k === 'err');
    expect(err![1].msg).toHaveLength(300);
  });

  test('unhandled rejections are written as err events', () => {
    recorder.start(ctx);
    const ev = new Event('unhandledrejection') as any;
    ev.reason = new Error('fetch failed');
    window.dispatchEvent(ev);
    expect(mockRrweb.custom).toHaveBeenCalledWith('dl', { k: 'err', msg: 'fetch failed' });
  });

  test('hidden tab: parks the buffer, one keepalive send when ≤ 16 KB, unparks on success', async () => {
    recorder.start(ctx);
    mockRrweb.emit!(inc(2));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(JSON.parse(sessionStorage.getItem(PARK_KEY)!)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect((fetchMock.mock.calls[0][1].body as Uint8Array).length).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    const env = decode(fetchMock.mock.calls[0]);
    expect(env.e.some((e: any) => e.type === 5 && e.data.payload.k === 'vis' && e.data.payload.hidden === true)).toBe(true);
    await flushPromises();
    expect(sessionStorage.getItem(PARK_KEY)).toBeNull();
  });

  test('unload with a chunk over 16 KB gzip: no keepalive, stays parked for the next page', () => {
    recorder.start(ctx);
    let seed = 1;
    const noise = Array.from({ length: 60_000 }, () => { seed = (seed * 48271) % 2147483647; return String.fromCharCode(33 + (seed % 90)); }).join('');
    mockRrweb.emit!(inc(2, { pad: noise }));
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).not.toHaveBeenCalled();
    const parked = JSON.parse(sessionStorage.getItem(PARK_KEY)!);
    expect(parked).toHaveLength(1);
    expect(parked[0].s).toBe('sess_a');
  });

  test('next page of the SAME session sends parked chunks; another session drops them', async () => {
    sessionStorage.setItem(PARK_KEY, JSON.stringify([
      { s: 'sess_a', p: 'p-old', q: 3, body: '{"w":"ws_pub_1","s":"sess_a","v":"anon_v1","p":"p-old","q":3,"sv":"1.8.0","rb":2,"e":[]}' },
      { s: 'sess_other', p: 'p-x', q: 0, body: '{"s":"sess_other"}' },
    ]));
    recorder.start(ctx);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decode(fetchMock.mock.calls[0])).toEqual(expect.objectContaining({ s: 'sess_a', p: 'p-old', q: 3 }));
    expect(sessionStorage.getItem(PARK_KEY)).toBeNull();
  });

  test('stop(true) (opt-out / consent withdrawn / reset / destroy) discards buffer and park, sends nothing', async () => {
    recorder.start(ctx);
    mockRrweb.emit!(inc(2));
    sessionStorage.setItem(PARK_KEY, JSON.stringify([{ s: 'sess_a', p: 'x', q: 0, body: '{}' }]));
    recorder.stop(true);
    expect(mockRrweb.stop).toHaveBeenCalled();
    expect(sessionStorage.getItem(PARK_KEY)).toBeNull();
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 3);
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    recorder.event('track', { name: 'x' });
    expect(mockRrweb.custom).not.toHaveBeenCalledWith('dl', { k: 'track', name: 'x' });
  });

  test('stop(false) flushes what is buffered', async () => {
    recorder.start(ctx);
    mockRrweb.emit!(inc(2));
    recorder.stop(false);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('session change: old buffer sent under the old id, then a full snapshot under the new one', async () => {
    recorder.start(ctx);
    mockRrweb.emit!(inc(2));
    recorder.sessionChanged('sess_b');
    await flushPromises();
    expect(decode(fetchMock.mock.calls[0]).s).toBe('sess_a');
    jest.advanceTimersByTime(1);
    expect(mockRrweb.full).toHaveBeenCalledWith(true);
    mockRrweb.emit!(inc(2));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    expect(decode(fetchMock.mock.calls[1]).s).toBe('sess_b');
  });

  test('idle pause: after 5 min without interaction, background mutations are dropped until activity resumes', async () => {
    recorder.start(ctx);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    fetchMock.mockClear();
    jest.setSystemTime(Date.now() + IDLE_PAUSE_MS + 1000);
    mockRrweb.emit!(inc(0, { adds: [{}], removes: [], texts: [], attributes: [] }));
    mockRrweb.emit!({ type: 2, data: {}, timestamp: Date.now() }, true); // periodic checkout while idle
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    mockRrweb.emit!(inc(2)); // a click
    jest.advanceTimersByTime(1);
    expect(mockRrweb.full).toHaveBeenCalledWith(true);
  });

  test('mutation throttle: one node rewritten in a loop is capped at the bucket', async () => {
    recorder.start(ctx);
    for (let i = 0; i < 300; i++) {
      mockRrweb.emit!(inc(0, { adds: [], removes: [], texts: [], attributes: [{ id: 42, attributes: { class: `c${i}` } }] }));
    }
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    const env = decode(fetchMock.mock.calls[0]);
    const mutations = env.e.filter((e: any) => e.type === 3 && e.data.source === 0);
    expect(mutations.length).toBeLessThanOrEqual(101);
    expect(mutations.length).toBeGreaterThanOrEqual(100);
  });

  test('5xx is retried with backoff; 4xx is not', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue({ ok: true, status: 204 });
    recorder.start(ctx);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 413 });
    mockRrweb.emit!(inc(2));
    recorder.flush();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    recorder.stop(true); // no further chunks: only retries could call fetch now
    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('start is idempotent and never throws when rrweb fails', () => {
    const { record } = jest.requireMock('@rrweb/record');
    record.mockClear();
    recorder.start(ctx);
    recorder.start(ctx);
    expect(record).toHaveBeenCalledTimes(1);
    recorder.stop(true);
    record.mockImplementationOnce(() => { throw new Error('unsupported'); });
    expect(() => recorder.start(ctx)).not.toThrow();
    expect(recorder.isRecording()).toBe(false);
  });
});
