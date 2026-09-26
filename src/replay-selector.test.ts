/**
 * Click fidelity (1.9.2): dlSelector, target resolution, fixed/page and box/offset math,
 * the heat click item shape and the replay-mode `clk` companion event.
 */
import { gunzipSync, strFromU8 } from 'fflate';

const mockCustom = jest.fn();
jest.mock('@rrweb/record', () => {
  const record: any = jest.fn(() => jest.fn());
  record.addCustomEvent = (tag: string, payload: unknown) => mockCustom(tag, payload);
  record.takeFullSnapshot = jest.fn();
  return { record };
});

import { SEL_MAX, clickFacts, clickPos, clickTarget, cssEscape, dlSelector, isGeneratedClass } from './replay/selector';
import { FLUSH_INTERVAL_MS, Recorder } from './replay/recorder';

const flushPromises = () => new Promise(resolve => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));
const ctx = {
  workspaceId: 'ws_pub_1', sdkVersion: '1.9.2', endpoint: 'https://replay.datalyr.com/replay',
  getSessionId: () => 'sess_s', getVisitorId: () => 'anon_v1',
  getAttribution: () => null as any,
};

const q = (sel: string) => document.querySelector(sel);
const rect = (el: Element, r: { left: number; top: number; width: number; height: number }) => {
  (el as any).getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} });
};
function mockStyles(map: Map<Element, Partial<CSSStyleDeclaration>>): jest.SpyInstance {
  const real = window.getComputedStyle.bind(window);
  return jest.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const s = map.get(el);
    return s ? ({ position: 'static', top: 'auto', bottom: 'auto', ...s } as CSSStyleDeclaration) : real(el);
  });
}
function geometry(vw = 1000, vh = 800, sx = 0, sy = 0, ph = 3000): void {
  Object.defineProperty(window, 'innerWidth', { value: vw, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: vh, configurable: true });
  Object.defineProperty(window, 'scrollX', { value: sx, configurable: true, writable: true });
  Object.defineProperty(window, 'scrollY', { value: sy, configurable: true, writable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: ph, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: vw, configurable: true });
}
function clickAt(el: Element, clientX: number, clientY: number): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
}

afterEach(() => { jest.restoreAllMocks(); document.body.innerHTML = ''; });

describe('dlSelector', () => {
  test('Tailwind classes are escaped and resolve back to the element', () => {
    document.body.innerHTML = `<section><div class="md:flex w-1/2 hover:bg-red-500 extra"><span class="p-2.5">x</span></div></section>`;
    const span = q('span')!;
    const sel = dlSelector(span);
    expect(sel).toBe('section > div.md\\:flex.w-1\\/2.hover\\:bg-red-500 > span.p-2\\.5');
    expect(document.querySelector(sel)).toBe(span);
  });

  test('repeated product cards get :nth-of-type', () => {
    document.body.innerHTML = `<ul class="grid">${[1, 2, 3].map(i => `<li class="card"><button class="buy">Buy ${i}</button></li>`).join('')}</ul>`;
    const btn = document.querySelectorAll('button')[1];
    const sel = dlSelector(btn);
    expect(sel).toBe('ul.grid > li.card:nth-of-type(2) > button.buy');
    expect(document.querySelector(sel)).toBe(btn);
  });

  test('unique id (with colons) anchors and stops; duplicate ids do not', () => {
    document.body.innerHTML = `<div id="radix:r1:"><p><a class="x">go</a></p></div><i id="dup"></i><i id="dup"><b>y</b></i>`;
    const a = q('a')!;
    const sel = dlSelector(a);
    expect(sel).toBe('#radix\\:r1\\: > p > a.x');
    expect(document.querySelector(sel)).toBe(a);
    const b = q('b')!;
    const selB = dlSelector(b);
    expect(selB).toBe('i:nth-of-type(2) > b');
    expect(document.querySelector(selB)).toBe(b);
  });

  test('generated classes skipped, at most 3 classes, 6 levels, body excluded', () => {
    expect(isGeneratedClass('css-1x2y3z')).toBe(true);
    expect(isGeneratedClass('sc-bdVaJa')).toBe(true);
    expect(isGeneratedClass('jsx-2938472')).toBe(true);
    expect(isGeneratedClass('Button_root__12345')).toBe(true);
    expect(isGeneratedClass('grid-cols-3')).toBe(false);
    document.body.innerHTML = `<div class="css-abc a b c d"><div><div><div><div><div><div><em class="sc-x t">z</em></div></div></div></div></div></div></div>`;
    const em = q('em')!;
    const sel = dlSelector(em);
    expect(sel.split(' > ')).toHaveLength(6);
    expect(sel.endsWith('em.t')).toBe(true);
    expect(sel).not.toMatch(/body|css-|sc-/);
    document.body.innerHTML = `<div class="css-abc a b c d"><em>z</em></div>`;
    expect(dlSelector(q('em'))).toBe('div.a.b.c > em');
  });

  test('cap 200: levels dropped from the root side whole, never mid-token', () => {
    const long = (i: number) => `level-${i}-${'x'.repeat(40)}`;
    let el: Element = document.body;
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div');
      d.className = long(i);
      el.appendChild(d);
      el = d;
    }
    const sel = dlSelector(el);
    expect(sel.length).toBeLessThanOrEqual(SEL_MAX);
    const tokens = sel.split(' > ');
    expect(tokens[tokens.length - 1]).toBe(`div.${long(7)}`);
    for (const t of tokens) expect(t).toMatch(/^div\.level-\d-x{40}$/);
    expect(document.querySelector(sel)).toBe(el);
  });

  test('cssEscape polyfill matches CSS.escape semantics used here', () => {
    const real = (globalThis as any).CSS;
    (globalThis as any).CSS = undefined;
    try {
      expect(cssEscape('md:flex')).toBe('md\\:flex');
      expect(cssEscape('w-1/2')).toBe('w-1\\/2');
      expect(cssEscape('1abc')).toBe('\\31 abc');
      expect(cssEscape('-')).toBe('\\-');
      document.body.innerHTML = `<div class="md:flex w-1/2"><span>x</span></div>`;
      expect(document.querySelector(dlSelector(q('span')))).toBe(q('span'));
    } finally {
      (globalThis as any).CSS = real;
    }
  });
});

describe('target, position, box', () => {
  test('target = nearest interactive ancestor within 3 levels, else the element', () => {
    document.body.innerHTML = `<button id="b"><span><i><em id="e">x</em></i></span></button><a id="a"><s><u><b><i id="deep">y</i></b></u></s></a>`;
    expect(clickTarget(q('#e'))).toBe(q('#b'));
    expect(clickTarget(q('#deep'))).toBe(q('#deep')); // a is 4 levels up
  });

  test('fixed ancestor → fixed; stuck sticky → fixed; unstuck sticky and static → page', () => {
    geometry();
    document.body.innerHTML = `<header id="h"><button id="b">x</button></header><nav id="s"><a id="l">y</a></nav><p id="p">z</p>`;
    const spy = mockStyles(new Map<Element, Partial<CSSStyleDeclaration>>([
      [q('#h')!, { position: 'fixed' }],
      [q('#s')!, { position: 'sticky', top: '10px' }],
    ]));
    expect(clickPos(q('#b'))).toBe('fixed');
    rect(q('#s')!, { left: 0, top: 10, width: 100, height: 40 });
    expect(clickPos(q('#l'))).toBe('fixed');
    rect(q('#s')!, { left: 0, top: 300, width: 100, height: 40 });
    expect(clickPos(q('#l'))).toBe('page');
    expect(clickPos(q('#p'))).toBe('page');
    spy.mockRestore();
  });

  test('box in page px (scroll added) for page; viewport px for fixed; offsets clamped, 4 dp', () => {
    geometry(1000, 800, 0, 1200);
    document.body.innerHTML = `<div id="f"><button id="fb">x</button></div><button id="pb">y</button>`;
    const spy = mockStyles(new Map([[q('#f')!, { position: 'fixed' }]]));
    rect(q('#pb')!, { left: 100.4, top: 50.6, width: 200, height: 30 });
    const target = q('#pb')!;
    let captured: any;
    const h = (e: Event) => { captured = clickFacts(e as MouseEvent); };
    document.addEventListener('click', h);
    clickAt(target, 150, 60);
    expect(captured).toMatchObject({ pos: 'page', bx: 100, by: 1251, bw: 200, bh: 30, ox: 0.248, oy: 0.3133, sel: '#pb' });
    rect(q('#fb')!, { left: 10, top: 20, width: 40, height: 40 });
    clickAt(q('#fb')!, 5, 90); // outside the box → clamped
    expect(captured).toMatchObject({ pos: 'fixed', bx: 10, by: 20, bw: 40, bh: 40, ox: 0, oy: 1 });
    document.removeEventListener('click', h);
    spy.mockRestore();
  });
});

describe('heat item + replay companion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sessionStorage.clear();
    mockCustom.mockClear();
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  });
  afterEach(() => { jest.useRealTimers(); delete (global as any).fetch; });

  test('heat click item carries pos/box/offsets; fixed uses clientY / vh', async () => {
    geometry(1000, 800, 0, 1000, 4000);
    document.body.innerHTML = `<header id="h"><a id="cta" class="btn">Buy</a></header><main><button id="pb"><span id="inner">Add</span></button></main>`;
    const spy = mockStyles(new Map([[q('#h')!, { position: 'fixed' }]]));
    rect(q('#cta')!, { left: 900, top: 10, width: 80, height: 40 });
    rect(q('#pb')!, { left: 100, top: 200, width: 100, height: 50 });
    const recorder = new Recorder();
    recorder.start(ctx, 'heat');
    const ev = (el: Element, cx: number, cy: number) => {
      const e = new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy });
      Object.defineProperty(e, 'pageX', { value: cx });
      Object.defineProperty(e, 'pageY', { value: cy + 1000 });
      el.dispatchEvent(e);
    };
    ev(q('#cta')!, 940, 30);
    ev(q('#inner')!, 150, 225);
    jest.advanceTimersByTime(3000);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    recorder.stop(false);
    await flushPromises();
    const fetchMock = (global as any).fetch as jest.Mock;
    const items = fetchMock.mock.calls.flatMap(c => JSON.parse(strFromU8(gunzipSync(c[1].body))).e).filter((i: any) => i.t === 'click');
    const [fixed, page] = items;
    expect(Object.keys(fixed).sort()).toEqual(['bh', 'bw', 'bx', 'by', 'kind', 'ox', 'oy', 'path', 'ph', 'pos', 'sel', 't', 'text', 'ts', 'vh', 'vw', 'x_pct', 'y_pct', 'y_px'].sort());
    expect(fixed).toMatchObject({ pos: 'fixed', y_pct: 0.0375, bx: 900, by: 10, bw: 80, bh: 40, ox: 0.5, oy: 0.5, sel: '#cta' });
    expect(page).toMatchObject({ pos: 'page', y_pct: 0.3063, y_px: 1225, bx: 100, by: 1200, bw: 100, bh: 50, ox: 0.5, oy: 0.5, sel: '#pb', text: 'Add' });
    spy.mockRestore();
  });

  test('replay mode: every click emits a dl clk Custom with the click ts; heat mode does not', () => {
    geometry(1000, 800, 0, 500);
    document.body.innerHTML = `<ul>${[1, 2].map(() => '<li><button class="buy">Buy</button></li>').join('')}</ul>`;
    const btn = document.querySelectorAll('button')[1];
    rect(btn, { left: 10, top: 100, width: 50, height: 20 });
    const recorder = new Recorder();
    recorder.start(ctx, 'replay');
    jest.setSystemTime(1_800_000_000_000);
    clickAt(btn, 35, 105);
    const clk = mockCustom.mock.calls.filter(([tag, p]) => tag === 'dl' && p.k === 'clk');
    expect(clk).toHaveLength(1);
    expect(clk[0][1]).toEqual({
      k: 'clk', ts: 1_800_000_000_000, pos: 'page', bx: 10, by: 600, bw: 50, bh: 20, ox: 0.5, oy: 0.25,
      sel: 'ul > li:nth-of-type(2) > button.buy', vw: 1000, vh: 800,
    });
    expect(JSON.stringify(clk[0][1])).not.toMatch(/Buy/);
    recorder.stop(true);
    mockCustom.mockClear();
    const heat = new Recorder();
    heat.start(ctx, 'heat');
    clickAt(btn, 35, 105);
    expect(mockCustom.mock.calls.filter(([, p]) => p.k === 'clk')).toHaveLength(0);
    heat.stop(true);
  });
});
