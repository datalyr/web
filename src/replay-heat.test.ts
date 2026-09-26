/**
 * Heat mode (1.9.0): the replay module started with mode 'heat'. No rrweb record();
 * click / scroll / attr / snap items in a `m:'heat'` envelope to ?enc=gzip&mode=heat.
 */
import { gunzipSync, strFromU8 } from 'fflate';

const mockRecord = jest.fn(() => jest.fn());
jest.mock('@rrweb/record', () => {
  const record: any = (...args: any[]) => (mockRecord as any)(...args);
  record.addCustomEvent = jest.fn();
  record.takeFullSnapshot = jest.fn();
  return { record };
});

let mockPageLoadId = 'pl-0';
jest.mock('./utils', () => ({ ...jest.requireActual('./utils'), generateUUID: () => mockPageLoadId }));

import { FLUSH_INTERVAL_MS, IDLE_PAUSE_MS, MAX_PAGE_MS, PARK_KEY, Recorder } from './replay/recorder';
import { DEAD_WAIT_MS, SNAP_MAX_RAW, heatSelector, heatSnapRoll } from './replay/heat';

const flushPromises = () => new Promise(resolve => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));

let sessionId = 'sess_h';
const ctx = {
  workspaceId: 'ws_pub_1',
  sdkVersion: '1.9.0',
  endpoint: 'https://replay.datalyr.com/replay',
  getSessionId: () => sessionId,
  getVisitorId: () => 'anon_v1',
  getAttribution: () => ({ source: 'facebook', medium: 'paid', campaign: 'c1', content: null, term: null, click: 'fbclid', landing_path: '/lp?x=1' } as any),
};

// Page load ids that do / do not win the 1-in-4 snapshot roll.
const SNAP_HIT = Array.from({ length: 200 }, (_, i) => `pl-${i}`).find(id => heatSnapRoll(id))!;
const SNAP_MISS = Array.from({ length: 200 }, (_, i) => `pl-${i}`).find(id => !heatSnapRoll(id))!;

function decode(call: any[]): any {
  return JSON.parse(strFromU8(gunzipSync(call[1].body as Uint8Array)));
}

function setGeometry(ph = 2000, pw = 1000, vw = 1000, vh = 800, scrollY = 0): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: ph, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: pw, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: vw, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: vh, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true, writable: true });
}

function click(el: Element, pageX = 100, pageY = 500): void {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pageX', { value: pageX });
  Object.defineProperty(ev, 'pageY', { value: pageY });
  el.dispatchEvent(ev);
}

function setPath(path: string): void {
  window.history.replaceState({}, '', path);
}

async function sent(fetchMock: jest.Mock): Promise<any[]> {
  await flushPromises();
  return fetchMock.mock.calls.map(decode);
}
const items = (envs: any[]) => envs.flatMap(e => e.e);

describe('heat mode', () => {
  let fetchMock: jest.Mock;
  let recorder: Recorder;

  beforeEach(() => {
    jest.useFakeTimers();
    sessionId = 'sess_h';
    mockPageLoadId = SNAP_MISS;
    sessionStorage.clear();
    mockRecord.mockClear();
    setGeometry();
    setPath('/products/shoe?utm_source=x#top');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.body.innerHTML = `
      <main id="main" class="page wide">
        <p id="p">Jane Doe, 1 High St</p>
        <button id="b" class="cta primary">Add to bag <span data-dl-mask>Hi Jane</span></button>
        <a id="a" href="/cart">Cart</a>
        <input id="i" value="typed secret" />
        <label id="l">Email <textarea>draft text</textarea></label>
        <div id="d">Nothing here</div>
      </main>`;
    (document.getElementById('i') as HTMLInputElement).value = 'jane@example.com';
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    (global as any).fetch = fetchMock;
    recorder = new Recorder();
  });

  afterEach(() => {
    recorder.stop(true);
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  test('advertises heat support; start(ctx, "heat") never calls rrweb record()', () => {
    expect(recorder.modes).toEqual(['replay', 'heat']);
    recorder.start(ctx, 'heat');
    expect(recorder.isRecording()).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('envelope = replay envelope + m:"heat", URL has mode=heat; attr item first', async () => {
    recorder.start(ctx, 'heat');
    click(document.getElementById('b')!);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    const [env] = await sent(fetchMock);
    expect(fetchMock.mock.calls[0][0]).toBe('https://replay.datalyr.com/replay?enc=gzip&mode=heat');
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }));
    expect(Object.keys(env)).toEqual(['w', 's', 'v', 'p', 'q', 'sv', 'rb', 'e', 'm']);
    expect(env).toEqual(expect.objectContaining({ w: 'ws_pub_1', s: 'sess_h', v: 'anon_v1', p: SNAP_MISS, q: 0, sv: '1.9.0', m: 'heat' }));
    expect(env.rb).toBe(Buffer.byteLength(JSON.stringify(env.e)));
    expect(env.e[0]).toEqual({
      t: 'attr', source: 'facebook', medium: 'paid', campaign: 'c1', content: null, term: null, click: 'fbclid', landing_path: '/lp',
    });
    expect(env.e.filter((i: any) => i.t === 'attr')).toHaveLength(1);
  });

  test('click record shape; interactive text kept, masked parts dropped', async () => {
    recorder.start(ctx, 'heat');
    click(document.getElementById('b')!, 250, 500);
    jest.advanceTimersByTime(DEAD_WAIT_MS);
    recorder.flush();
    const c = items(await sent(fetchMock)).find((i: any) => i.t === 'click');
    expect(c).toEqual({
      t: 'click', ts: expect.any(Number), path: '/products/shoe',
      x_pct: 0.25, y_pct: 0.25, y_px: 500, vw: 1000, vh: 800, ph: 2000,
      text: 'Add to bag', sel: 'body > main#main.page.wide > button#b.cta.primary', kind: 'dead',
    });
    expect(Object.keys(c)).toEqual(['t', 'ts', 'path', 'x_pct', 'y_pct', 'y_px', 'vw', 'vh', 'ph', 'text', 'sel', 'kind']);
  });

  test('never records typed values or non-interactive text', async () => {
    recorder.start(ctx, 'heat');
    for (const id of ['p', 'i', 'l', 'd']) click(document.getElementById(id)!);
    click(document.querySelector('textarea')!);
    jest.advanceTimersByTime(DEAD_WAIT_MS);
    recorder.flush();
    const envs = await sent(fetchMock);
    const clicks = items(envs).filter((i: any) => i.t === 'click');
    // p, input, div → ''; label and the textarea inside it → the label's own text only
    // (a label click also dispatches a click on its control).
    expect(clicks.length).toBeGreaterThanOrEqual(5);
    expect(new Set(clicks.map((c: any) => c.text))).toEqual(new Set(['', 'Email']));
    expect(clicks.filter((c: any) => c.sel.endsWith('input#i') || c.sel.endsWith('p#p') || c.sel.endsWith('div#d')).map((c: any) => c.text)).toEqual(['', '', '']);
    const json = JSON.stringify(envs);
    expect(json).not.toMatch(/jane@example|typed secret|Jane Doe|High St|draft text|Hi Jane|Nothing here/);
    expect(json).not.toMatch(/utm_source|#top/);
  });

  test('selector is capped at 200 chars, nearest part kept', () => {
    let el: Element = document.body;
    for (let i = 0; i < 30; i++) {
      const d = document.createElement('div');
      d.className = `level-${i}`;
      el.appendChild(d);
      el = d;
    }
    const sel = heatSelector(el);
    expect(sel.length).toBeLessThanOrEqual(200);
    expect(sel.endsWith('div.level-29')).toBe(true);
  });

  test('rage: 3 clicks < 1 s apart within 30 px → the 3rd is rage; spread-out clicks are not', async () => {
    recorder.start(ctx, 'heat');
    const a = document.getElementById('a')!; // links are never dead, so kinds come out at once
    click(a, 100, 100);
    jest.advanceTimersByTime(300);
    click(a, 110, 105);
    jest.advanceTimersByTime(300);
    click(a, 120, 110);
    jest.advanceTimersByTime(300);
    click(a, 400, 400); // far away: streak restarts
    jest.advanceTimersByTime(1500);
    click(a, 400, 400);
    jest.advanceTimersByTime(900);
    click(a, 400, 400);
    recorder.flush();
    const kinds = items(await sent(fetchMock)).filter((i: any) => i.t === 'click').map((c: any) => c.kind);
    expect(kinds).toEqual(['click', 'click', 'rage', 'click', 'click', 'click']);
  });

  test('dead: no mutation within 2.5 s → dead; a DOM change or quick scroll → click; links/inputs never dead', async () => {
    recorder.start(ctx, 'heat');
    const d = document.getElementById('d')!;
    click(d);
    jest.advanceTimersByTime(DEAD_WAIT_MS);

    click(d, 600, 600);
    jest.advanceTimersByTime(500);
    d.setAttribute('data-open', '1');
    await Promise.resolve(); // MutationObserver delivery
    jest.advanceTimersByTime(DEAD_WAIT_MS);

    click(d, 300, 900);
    jest.advanceTimersByTime(50);
    window.dispatchEvent(new Event('scroll'));
    jest.advanceTimersByTime(DEAD_WAIT_MS);

    click(document.getElementById('i')!, 10, 10);
    click(document.getElementById('a')!, 900, 10);
    jest.advanceTimersByTime(DEAD_WAIT_MS);
    recorder.flush();
    const kinds = items(await sent(fetchMock)).filter((i: any) => i.t === 'click').map((c: any) => c.kind);
    expect(kinds).toEqual(['dead', 'click', 'click', 'click', 'click']);
  });

  test('scroll depth: max per path, emitted on hidden and on SPA path change, origin-less path', async () => {
    recorder.start(ctx, 'heat');
    (window as any).scrollY = 700;
    window.dispatchEvent(new Event('scroll'));
    (window as any).scrollY = 200; // scrolled back up: max stays
    window.dispatchEvent(new Event('scroll'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    let scrolls = items(await sent(fetchMock)).filter((i: any) => i.t === 'scroll');
    expect(scrolls).toEqual([{ t: 'scroll', ts: expect.any(Number), path: '/products/shoe', y_pct_max: 0.75, ph: 2000 }]);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);

    fetchMock.mockClear();
    setPath('/cart?step=2');
    recorder.event('url', { href: 'https://shop.test/cart?step=2' });
    recorder.flush();
    scrolls = items(await sent(fetchMock)).filter((i: any) => i.t === 'scroll');
    // The old path's depth did not change since hidden, so nothing new for it; the new path starts at its first screen.
    expect(scrolls).toEqual([]);
    (window as any).scrollY = 1200;
    window.dispatchEvent(new Event('scroll'));
    setPath('/checkout');
    click(document.getElementById('a')!);
    recorder.flush();
    scrolls = items(await sent(fetchMock)).filter((i: any) => i.t === 'scroll');
    expect(scrolls).toEqual([{ t: 'scroll', ts: expect.any(Number), path: '/cart', y_pct_max: 1, ph: 2000 }]);
  });

  test('scroll depth is emitted on unload (parked for the next page)', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    recorder.start(ctx, 'heat');
    (window as any).scrollY = 400;
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pagehide'));
    const parked = JSON.parse(sessionStorage.getItem(PARK_KEY)!);
    expect(parked[0].m).toBe('heat');
    const env = JSON.parse(parked[0].body);
    expect(env.m).toBe('heat');
    expect(env.e.find((i: any) => i.t === 'scroll')).toEqual(expect.objectContaining({ path: '/products/shoe', y_pct_max: 0.6 }));
  });

  test('snap: only when the roll hits, in chunk q 0, masked, ≤ 900 KB', async () => {
    mockPageLoadId = SNAP_HIT;
    recorder.start(ctx, 'heat');
    recorder.flush();
    const [env] = await sent(fetchMock);
    expect(env.q).toBe(0);
    const snaps = env.e.filter((i: any) => i.t === 'snap');
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toEqual({ t: 'snap', ts: expect.any(Number), path: '/products/shoe', vw: 1000, snapshot: expect.any(Object) });
    const json = JSON.stringify(snaps[0]);
    expect(json).toContain('Add to bag');
    expect(json).not.toMatch(/Jane Doe|jane@example|typed secret|Hi Jane|Nothing here/);
  });

  test('privacy textMode in heat: all → button text dropped (data-dl-unmask kept); marked → only [data-dl-mask] dropped', async () => {
    document.getElementById('d')!.setAttribute('data-dl-unmask', '');
    recorder.start(ctx, 'heat', { textMode: 'all', attributes: false, urlQuery: false });
    click(document.getElementById('b')!, 250, 500);
    click(document.getElementById('a')!, 250, 900);
    jest.advanceTimersByTime(DEAD_WAIT_MS);
    recorder.flush();
    let clicks = items(await sent(fetchMock)).filter((i: any) => i.t === 'click');
    expect(clicks.map((c: any) => c.text)).toEqual(['', '']);
    recorder.stop(true);
    fetchMock.mockClear();
    recorder = new Recorder();
    recorder.start(ctx, 'heat', { textMode: 'marked', attributes: false, urlQuery: false });
    click(document.getElementById('b')!, 250, 500);
    jest.advanceTimersByTime(DEAD_WAIT_MS);
    recorder.flush();
    clicks = items(await sent(fetchMock)).filter((i: any) => i.t === 'click');
    expect(clicks[0].text).toBe('Add to bag');
  });

  test('privacy in the heat snap: marked keeps plain text, attributes/url scrubbed by default, kept when relaxed', async () => {
    document.getElementById('main')!.insertAdjacentHTML('beforeend',
      '<img alt="alt-secret" src="https://cdn.test/a.png?sig=src-secret"><a href="/acct?token=href-secret">Acct</a>');
    mockPageLoadId = SNAP_HIT;
    recorder.start(ctx, 'heat', { textMode: 'marked', attributes: false, urlQuery: false });
    recorder.flush();
    let json = JSON.stringify((await sent(fetchMock))[0].e.find((i: any) => i.t === 'snap'));
    expect(json).toContain('Jane Doe, 1 High St');
    expect(json).not.toMatch(/Hi Jane|jane@example|alt-secret|src-secret|href-secret/);
    recorder.stop(true);
    fetchMock.mockClear();
    recorder = new Recorder();
    recorder.start(ctx, 'heat', { textMode: 'interactive', attributes: true, urlQuery: true });
    recorder.flush();
    json = JSON.stringify((await sent(fetchMock))[0].e.find((i: any) => i.t === 'snap'));
    expect(json).toMatch(/alt-secret/);
    expect(json).toMatch(/src-secret/);
    expect(json).toMatch(/href-secret/);
    expect(json).not.toMatch(/Jane Doe/);
  });

  test('snap: no roll hit → none (roll is a pure function of page_load_id)', async () => {
    recorder.start(ctx, 'heat');
    recorder.flush();
    expect(items(await sent(fetchMock)).some((i: any) => i.t === 'snap')).toBe(false);
    expect(heatSnapRoll(SNAP_HIT)).toBe(true);
    expect(heatSnapRoll(SNAP_MISS)).toBe(false);
  });

  test('snap: dropped when its JSON exceeds 900 KB', async () => {
    mockPageLoadId = SNAP_HIT;
    document.body.innerHTML = `<p>${'x'.repeat(SNAP_MAX_RAW)}</p>`;
    recorder.start(ctx, 'heat');
    recorder.flush();
    const envs = await sent(fetchMock);
    expect(items(envs).some((i: any) => i.t === 'snap')).toBe(false);
    expect(items(envs)[0].t).toBe('attr');
  });

  test('stop(true) discards: nothing held leaves, listeners gone', async () => {
    recorder.start(ctx, 'heat');
    click(document.getElementById('d')!);
    recorder.stop(true);
    jest.advanceTimersByTime(DEAD_WAIT_MS + FLUSH_INTERVAL_MS);
    click(document.getElementById('a')!);
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorder.isRecording()).toBe(false);
  });

  test('idle: stops listening after 5 min without interaction, resumes on interaction', async () => {
    recorder.start(ctx, 'heat');
    jest.advanceTimersByTime(IDLE_PAUSE_MS + FLUSH_INTERVAL_MS);
    await flushPromises();
    fetchMock.mockClear();
    const a = document.getElementById('a')!;
    click(a); // no pointerdown first: listener is detached, nothing recorded
    recorder.flush();
    expect(await sent(fetchMock)).toEqual([]);
    a.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    click(a);
    recorder.flush();
    expect(items(await sent(fetchMock)).filter((i: any) => i.t === 'click')).toHaveLength(1);
  });

  test('page cap: capture ends after 60 min', async () => {
    recorder.start(ctx, 'heat');
    const a = document.getElementById('a')!;
    for (let t = 0; t <= MAX_PAGE_MS; t += 4 * 60 * 1000) {
      click(a); // keep it from going idle
      jest.advanceTimersByTime(4 * 60 * 1000);
    }
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(recorder.isRecording()).toBe(false);
    recorder.start(ctx, 'heat');
    expect(recorder.isRecording()).toBe(false);
  });

  test('session change: flushes under the old id, new chunks carry the new id and an attr', async () => {
    recorder.start(ctx, 'heat');
    click(document.getElementById('a')!);
    recorder.sessionChanged('sess_new');
    click(document.getElementById('a')!);
    recorder.flush();
    const envs = await sent(fetchMock);
    expect(envs.map(e => e.s)).toEqual(['sess_h', 'sess_new']);
    expect(envs[1].e[0].t).toBe('attr');
  });

  test('replay-only custom events are ignored in heat mode', async () => {
    recorder.start(ctx, 'heat');
    recorder.event('track', { name: 'purchase' });
    recorder.event('vis', { hidden: false });
    recorder.flush();
    const json = JSON.stringify(await sent(fetchMock));
    expect(json).not.toContain('purchase');
  });
});
