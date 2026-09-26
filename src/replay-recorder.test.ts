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
  FLUSH_INTERVAL_MS, IDLE_PAUSE_MS, KEEPALIVE_MAX_BYTES, PARK_KEY, Recorder, maskText, stripUrl,
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
      maskAllInputs: false,
      maskInputOptions: { input: true, textarea: true, select: true, password: true },
      maskTextSelector: '*',
      maskTextFn: expect.any(Function),
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

  test('privacy textMode: all masks interactive text too (data-dl-unmask kept); marked masks only [data-dl-mask]', () => {
    document.body.innerHTML = `<p id="p">Jane Doe</p><button id="b">Add to bag</button>
      <div data-dl-unmask><h2 id="u">Free shipping</h2></div><div data-dl-mask><span id="m">Hi Jane</span></div>`;
    const el = (id: string) => document.getElementById(id) as HTMLElement;
    recorder.start(ctx, 'replay', { textMode: 'all', attributes: false, urlQuery: false });
    let fn = mockRrweb.opts.maskTextFn;
    expect(fn('Add to bag', el('b'))).toBe('*** ** ***');
    expect(fn('Jane Doe', el('p'))).toBe('**** ***');
    expect(fn('Free shipping', el('u'))).toBe('Free shipping');
    recorder.stop(true);
    recorder = new Recorder();
    recorder.start(ctx, 'replay', { textMode: 'marked', attributes: false, urlQuery: false });
    fn = mockRrweb.opts.maskTextFn;
    expect(fn('Jane Doe', el('p'))).toBe('Jane Doe');
    expect(fn('Hi Jane', el('m'))).toBe('** ****');
    // Inputs stay masked in every mode.
    expect(mockRrweb.opts.maskInputOptions).toEqual({ input: true, textarea: true, select: true, password: true });
    recorder.stop(true);
    recorder = new Recorder();
    recorder.start(ctx, 'replay', { textMode: 'bogus' } as any);
    fn = mockRrweb.opts.maskTextFn;
    expect(fn('Add to bag', el('b'))).toBe('Add to bag');
    expect(fn('Jane Doe', el('p'))).toBe('**** ***');
  });

  test('privacy scrub in onEmit: attribute mutations; Meta href stripped even with urlQuery true', async () => {
    recorder.start(ctx, 'replay', { textMode: 'interactive', attributes: false, urlQuery: false });
    mockRrweb.emit!(inc(0, { adds: [], removes: [], texts: [], attributes: [
      { id: 7, attributes: { href: '/a?t=1#x', title: 'secret', 'data-x': 'y', class: 'keep', style: { color: 'red' }, alt: null } },
    ] }));
    recorder.flush();
    await flushPromises();
    const env = decode(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]);
    const mut = env.e.find((e: any) => e.type === 3 && e.data.source === 0);
    expect(mut.data.attributes[0].attributes).toEqual({ href: '/a', title: '', 'data-x': '', class: 'keep', style: { color: 'red' }, alt: null });
    recorder.stop(true);
    fetchMock.mockClear();
    recorder = new Recorder();
    recorder.start(ctx, 'replay', { textMode: 'interactive', attributes: true, urlQuery: true });
    mockRrweb.emit!({ type: 4, data: { href: 'https://shop.test/p?email=a@b.c', width: 1, height: 1 }, timestamp: Date.now() });
    mockRrweb.emit!(inc(0, { adds: [], removes: [], texts: [], attributes: [{ id: 7, attributes: { href: '/a?t=1', title: 'kept' } }] }));
    recorder.flush();
    await flushPromises();
    const env2 = decode(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]);
    expect(env2.e.find((e: any) => e.type === 4).data.href).toBe('https://shop.test/p');
    expect(env2.e.find((e: any) => e.type === 3).data.attributes[0].attributes).toEqual({ href: '/a?t=1', title: 'kept' });
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
    // attr + ph custom events from start(), then meta + full snapshot.
    expect(env.e.map((e: any) => e.type)).toEqual([5, 5, 4, 2]);
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

  test('URLs: Meta href and url Custom event keep origin+pathname only', async () => {
    recorder.start(ctx);
    mockRrweb.emit!({ type: 4, data: { href: 'https://shop.test/account/reset/123?token=abc&email=j%40x.test#frag', width: 1, height: 1 }, timestamp: 1 });
    recorder.event('url', { href: 'https://shop.test/checkouts/c/xyz/thank_you?key=secretkey#x' });
    mockRrweb.emit!({ type: 4, data: { href: 'not a url::' }, timestamp: 2 });
    recorder.flush();
    await flushPromises();
    const env = decode(fetchMock.mock.calls[0]);
    const json = JSON.stringify(env);
    expect(json).not.toMatch(/token=|email=|key=|secretkey|#frag/);
    const metas = env.e.filter((e: any) => e.type === 4);
    expect(metas[0].data).toEqual({ href: 'https://shop.test/account/reset/123', width: 1, height: 1 });
    const url = env.e.find((e: any) => e.type === 5 && e.data.payload.k === 'url');
    expect(url.data.payload.href).toBe('https://shop.test/checkouts/c/xyz/thank_you');
    expect(stripUrl('https://a.test/p?q=1')).toBe('https://a.test/p');
    expect(stripUrl(undefined)).toBe('');
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

  test('stop(true) cancels pending retries and sends not yet posted (consent withdrawn)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    recorder.start(ctx);
    mockRrweb.emit!(inc(2));
    recorder.flush();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1); // first attempt failed, retry scheduled
    mockRrweb.emit!(inc(2));
    recorder.flush(); // gzip in flight, not yet posted
    recorder.stop(true);
    fetchMock.mockClear();
    for (let i = 0; i < 8; i++) {
      jest.advanceTimersByTime(20_000);
      await flushPromises();
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

  describe('attr marker (1.8.2)', () => {
    const snapshotOnStart = () => {
      const { record } = jest.requireMock('@rrweb/record');
      record.mockImplementationOnce((opts: any) => {
        mockRrweb.opts = opts;
        mockRrweb.emit = opts.emit;
        opts.emit({ type: 4, data: { href: 'https://shop.test/p?utm_source=fb&fbclid=SECRET', width: 1, height: 1 }, timestamp: Date.now() });
        opts.emit({ type: 2, data: { node: {} }, timestamp: Date.now() });
        return mockRrweb.stop;
      });
    };

    test('emitted right after the full snapshot, allowlisted fields, no click id value', async () => {
      snapshotOnStart();
      recorder.start({
        ...ctx,
        getAttribution: () => ({
          source: 'facebook', medium: 'paid', campaign: 'c'.repeat(300), content: 'ad1', term: null,
          clickIdType: 'fbclid', clickId: 'SECRET', landingPath: '/p?x=1', landingPage: 'https://shop.test/p?fbclid=SECRET',
        } as any),
      });
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      await flushPromises();
      const events = decode(fetchMock.mock.calls[0]).e;
      expect(events.slice(0, 3).map((e: any) => e.type)).toEqual([4, 2, 5]);
      const attr = events[2].data;
      expect(attr.tag).toBe('dl');
      expect(attr.payload).toEqual({
        k: 'attr', source: 'facebook', medium: 'paid', campaign: 'c'.repeat(100), content: 'ad1',
        term: null, click: 'fbclid', landing_path: '/p',
      });
      expect(JSON.stringify(events)).not.toContain('SECRET');
    });

    test('empty attribution (or an older dl.js without the getter) still emits, all nulls', async () => {
      snapshotOnStart();
      recorder.start(ctx);
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      await flushPromises();
      const events = decode(fetchMock.mock.calls[0]).e;
      expect(events[2].data.payload).toEqual({
        k: 'attr', source: null, medium: null, campaign: null, content: null, term: null, click: null, landing_path: null,
      });
    });

    test('unknown click kinds are dropped; forwarded attr events are re-sanitized', () => {
      recorder.start({ ...ctx, getAttribution: () => ({ clickIdType: 'msclkid' } as any) });
      expect(mockRrweb.custom).toHaveBeenCalledWith('dl', expect.objectContaining({ k: 'attr', click: null }));
      mockRrweb.custom.mockClear();
      recorder.event('attr', { source: 'google', clickId: 'SECRET', landingPage: 'https://x/?gclid=SECRET', click: 'gclid' });
      const pushed = (recorder as any).buf.at(-1).data.payload;
      expect(pushed).toEqual({ k: 'attr', source: 'google', medium: null, campaign: null, content: null, term: null, click: 'gclid', landing_path: null });
    });

    test('a session change re-emits the marker after the new full snapshot', () => {
      recorder.start({ ...ctx, getAttribution: () => ({ source: 'tiktok', clickIdType: 'ttclid' } as any) });
      mockRrweb.custom.mockClear();
      recorder.sessionChanged('sess_b');
      jest.advanceTimersByTime(0);
      expect(mockRrweb.full).toHaveBeenCalled();
      expect(mockRrweb.custom).toHaveBeenCalledWith('dl', expect.objectContaining({ k: 'attr', source: 'tiktok', click: 'ttclid' }));
    });
  });
});
