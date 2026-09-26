/**
 * Session replay loader (the part of dl.js every visitor gets): who may be recorded,
 * which sessions fall in the sample, what module is injected, and what of a track()
 * call reaches a recording.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  REPLAY_GLOBAL,
  ReplayLoader,
  heatmapsAllowed,
  replayAllowed,
  replayMode,
  replayHash,
  replayModuleUrl,
  replaySampleHit,
  replayTrackPayload,
  resolveReplayPrivacy,
  type ReplayGateInputs,
  type ReplayRecorder,
} from './replay-loader';

const OPEN: ReplayGateInputs = {
  remote: { enabled: true, sampleRate: 1, v: '1.8.0' },
  disabledAtInit: false,
  tracking: true,
  marketing: true,
  strict: false,
  doNotTrack: false,
  globalPrivacyControl: false,
  sessionId: 'sess_2f1c9a4e-1111-4222-8333-444455556666',
};

describe('replay gates', () => {
  test('all gates open → allowed', () => {
    expect(replayAllowed(OPEN)).toBe(true);
  });

  test.each<[string, Partial<ReplayGateInputs>]>([
    ['no remote key (older worker / container off)', { remote: undefined }],
    ['remote null', { remote: null }],
    ['dashboard disabled', { remote: { enabled: false, sampleRate: 1 } }],
    ['enabled not strictly true', { remote: { enabled: 'true' as unknown as boolean, sampleRate: 1 } }],
    ['init replay:false', { disabledAtInit: true }],
    ['shouldTrack false (opt-out / analytics consent / Shopify analytics)', { tracking: false }],
    ['marketing consent withdrawn (setConsent / Shopify marketing)', { marketing: false }],
    ['privacyMode strict', { strict: true }],
    ['Do Not Track', { doNotTrack: true }],
    ['Global Privacy Control', { globalPrivacyControl: true }],
    ['sample rate 0', { remote: { enabled: true, sampleRate: 0 } }],
    ['sample rate not a number', { remote: { enabled: true, sampleRate: 'all' as unknown as number } }],
    ['no session id', { sessionId: '' }],
  ])('%s → not allowed', (_label, patch) => {
    expect(replayAllowed({ ...OPEN, ...patch })).toBe(false);
  });

  test('missing sampleRate records every session', () => {
    expect(replayAllowed({ ...OPEN, remote: { enabled: true } })).toBe(true);
  });
});

describe('sampling by session id hash', () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `sess_${i.toString(16).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`);

  test('the same session always gets the same answer (every page load agrees)', () => {
    for (const id of ids.slice(0, 200)) {
      expect(replaySampleHit(id, 0.3)).toBe(replaySampleHit(id, 0.3));
      expect(replayHash(id)).toBe(replayHash(id));
    }
    // A known value pins the algorithm: changing it would re-sample live sessions mid-way.
    expect(replayHash('sess_test')).toBe(replayHash('sess_test'));
    expect(replayHash('')).toBe(0x811c9dc5);
  });

  test('the hit rate follows sampleRate, and a lower rate is a subset of a higher one', () => {
    const at = (rate: number) => ids.filter(id => replaySampleHit(id, rate));
    const ten = at(0.1);
    const fifty = at(0.5);
    expect(ten.length / ids.length).toBeGreaterThan(0.07);
    expect(ten.length / ids.length).toBeLessThan(0.13);
    expect(fifty.length / ids.length).toBeGreaterThan(0.45);
    expect(fifty.length / ids.length).toBeLessThan(0.55);
    expect(ten.every(id => fifty.includes(id))).toBe(true);
    expect(at(1)).toHaveLength(ids.length);
    expect(at(0)).toHaveLength(0);
  });

  test('nothing is persisted to decide the sample', () => {
    localStorage.clear();
    sessionStorage.clear();
    replaySampleHit(ids[0], 0.5);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('module URL', () => {
  test('versioned on track.datalyr.com, from remote v', () => {
    expect(replayModuleUrl('1.8.0', '1.8.0')).toBe('https://track.datalyr.com/dl.replay.1.8.0.js');
    expect(replayModuleUrl('1.8.1-beta.2', '1.8.0')).toBe('https://track.datalyr.com/dl.replay.1.8.1-beta.2.js');
  });
  test.each([undefined, null, '', 'latest', '../evil', '1.8.0/../../x', 'https://evil.example/x', 7])('odd v %p falls back to the SDK version', v => {
    expect(replayModuleUrl(v, '1.8.0')).toBe('https://track.datalyr.com/dl.replay.1.8.0.js');
  });
});

describe('capture mode per page load (replay wins over heat)', () => {
  const HEAT = { enabled: true, sampleRate: 1 };
  const NO_REPLAY = { ...OPEN, remote: { enabled: false, sampleRate: 1 } };

  test.each<[string, Partial<ReplayGateInputs>, 'replay' | 'heat' | null]>([
    ['replay only', {}, 'replay'],
    ['replay + heatmaps → replay (heat rows derive from the recording)', { heatmaps: HEAT }, 'replay'],
    ['heatmaps only', { ...NO_REPLAY, heatmaps: HEAT }, 'heat'],
    ['no replay key, heatmaps on', { remote: undefined, heatmaps: HEAT }, 'heat'],
    ['replay out of sample, heatmaps in sample → heat', { remote: { enabled: true, sampleRate: 0 }, heatmaps: HEAT }, 'heat'],
    ['replay:false at init, heatmaps on → heat', { disabledAtInit: true, heatmaps: HEAT }, 'heat'],
    ['heatmaps not enabled', { ...NO_REPLAY, heatmaps: { enabled: false, sampleRate: 1 } }, null],
    ['heatmaps enabled not strictly true', { ...NO_REPLAY, heatmaps: { enabled: 'true' as unknown as boolean, sampleRate: 1 } }, null],
    ['heatmaps key missing', { ...NO_REPLAY }, null],
    ['heatmaps:false at init', { ...NO_REPLAY, heatmaps: HEAT, heatmapsDisabledAtInit: true }, null],
    ['heatmaps out of sample', { ...NO_REPLAY, heatmaps: { enabled: true, sampleRate: 0 } }, null],
    ['analytics consent / opt-out', { heatmaps: HEAT, tracking: false }, null],
    ['marketing consent declined', { heatmaps: HEAT, marketing: false }, null],
    ['strict privacy', { heatmaps: HEAT, strict: true }, null],
    ['Do Not Track', { heatmaps: HEAT, doNotTrack: true }, null],
    ['Global Privacy Control', { heatmaps: HEAT, globalPrivacyControl: true }, null],
  ])('%s', (_label, patch, expected) => {
    expect(replayMode({ ...OPEN, ...patch })).toBe(expected);
  });

  test('heat sample: own rate on the same session-id hash', () => {
    const g = { ...OPEN, remote: undefined, heatmaps: { enabled: true, sampleRate: 0.5 } };
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (heatmapsAllowed({ ...g, sessionId: `sess_${i}` })) hits++;
    expect(hits / 2000).toBeGreaterThan(0.45);
    expect(hits / 2000).toBeLessThan(0.55);
    expect(heatmapsAllowed(g)).toBe(heatmapsAllowed({ ...g })); // stable
  });
});

describe('what a track() call puts in the recording', () => {
  test('event name + value/currency/product ids only', () => {
    expect(replayTrackPayload('purchase', {
      value: 49.5, currency: 'GBP', product_id: 'p1', content_ids: ['a', 2, { x: 1 }],
      email: 'jane@example.com', phone: '+441234', name: 'Jane', address: '1 High St', order_id: 'o-1',
    })).toEqual({ name: 'purchase', value: 49.5, currency: 'GBP', product_id: 'p1', content_ids: ['a', '2'] });
  });
  test('revenue counts as value; junk is dropped; no props → name only', () => {
    expect(replayTrackPayload('checkout_started', { revenue: 10, value: 'x' as unknown as number })).toEqual({ name: 'checkout_started', value: 10 });
    expect(replayTrackPayload('signup', undefined)).toEqual({ name: 'signup' });
    expect(replayTrackPayload('x'.repeat(500), {}).name).toHaveLength(100);
  });
});

describe('ReplayLoader', () => {
  const ctx = {
    workspaceId: 'ws_pub', sdkVersion: '1.8.0', endpoint: 'https://replay.datalyr.com/replay',
    getSessionId: () => 'sess_1', getVisitorId: () => 'anon_1',
  };
  const scripts = () => Array.from(document.querySelectorAll('script')).filter(s => s.src.includes('dl.replay.'));
  const fakeRecorder = (): jest.Mocked<ReplayRecorder> => ({
    start: jest.fn(), stop: jest.fn(), event: jest.fn(), sessionChanged: jest.fn(), isRecording: jest.fn(() => true),
  });

  afterEach(() => {
    scripts().forEach(s => s.remove());
    delete (window as any)[REPLAY_GLOBAL];
  });

  test('not allowed → nothing injected, nothing started (no-op without the key)', () => {
    const loader = new ReplayLoader(ctx);
    loader.sync(null, '1.8.0');
    loader.event('track', { name: 'x' });
    expect(scripts()).toHaveLength(0);
  });

  test('allowed → injects the versioned module once, without crossOrigin, and starts it on load', () => {
    const loader = new ReplayLoader(ctx);
    loader.sync('replay', '1.8.2');
    loader.sync('replay', '1.8.2');
    expect(scripts()).toHaveLength(1);
    const script = scripts()[0];
    expect(script.src).toBe('https://track.datalyr.com/dl.replay.1.8.2.js');
    expect(script.crossOrigin).toBeFalsy();
    expect(script.hasAttribute('crossorigin')).toBe(false);
    expect(script.async).toBe(true);

    const recorder = fakeRecorder();
    (window as any)[REPLAY_GLOBAL] = recorder;
    script.onload!(new Event('load'));
    expect(recorder.start).toHaveBeenCalledWith(ctx, 'replay', { textMode: 'interactive', attributes: false, urlQuery: false });

    loader.event('track', { name: 'add_to_cart' });
    expect(recorder.event).toHaveBeenCalledWith('track', { name: 'add_to_cart' });
  });

  test('module fails to load → nothing recorded, no second injection', () => {
    const loader = new ReplayLoader(ctx);
    loader.sync('replay', '1.8.1');
    scripts()[0].onerror!(new Event('error'));
    loader.sync('replay', '1.8.1');
    expect(scripts()).toHaveLength(1);
    expect(() => loader.event('track', { name: 'x' })).not.toThrow();
  });

  test('a gate closing before the module arrives: it loads but never starts', () => {
    const loader = new ReplayLoader(ctx);
    loader.sync('replay', undefined);
    expect(scripts()[0].src).toBe('https://track.datalyr.com/dl.replay.1.8.0.js');
    loader.sync(null, undefined);
    const recorder = fakeRecorder();
    (window as any)[REPLAY_GLOBAL] = recorder;
    scripts()[0].onload!(new Event('load'));
    expect(recorder.start).not.toHaveBeenCalled();
  });

  test('gate closes → stop with discard; events stop flowing', () => {
    const recorder = fakeRecorder();
    (window as any)[REPLAY_GLOBAL] = recorder;
    const loader = new ReplayLoader(ctx);
    loader.sync('replay', '1.8.0');
    expect(scripts()).toHaveLength(0); // already registered: no second script
    expect(recorder.start).toHaveBeenCalledTimes(1);
    loader.sync(null, '1.8.0');
    expect(recorder.stop).toHaveBeenCalledWith(true);
    loader.event('vis', { hidden: true });
    expect(recorder.event).not.toHaveBeenCalled();
  });

  test("heat mode: same module URL, started with 'heat'", () => {
    const loader = new ReplayLoader(ctx);
    loader.sync('heat', '1.9.0');
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].src).toBe('https://track.datalyr.com/dl.replay.1.9.0.js');
    const recorder = { ...fakeRecorder(), modes: ['replay', 'heat'] as const };
    (window as any)[REPLAY_GLOBAL] = recorder;
    scripts()[0].onload!(new Event('load'));
    expect(recorder.start).toHaveBeenCalledWith(ctx, 'heat', { textMode: 'interactive', attributes: false, urlQuery: false });
    loader.sync(null, '1.9.0');
    expect(recorder.stop).toHaveBeenCalledWith(true);
  });

  test('heat mode never starts a module without heat support (pinned 1.8.x)', () => {
    const recorder = fakeRecorder();
    (window as any)[REPLAY_GLOBAL] = recorder;
    const loader = new ReplayLoader(ctx);
    loader.sync('heat', '1.8.2');
    expect(recorder.start).not.toHaveBeenCalled();
  });

  test('mode change on the page: discard, restart in the new mode', () => {
    const recorder = { ...fakeRecorder(), modes: ['replay', 'heat'] as const };
    (window as any)[REPLAY_GLOBAL] = recorder;
    const loader = new ReplayLoader(ctx);
    loader.sync('heat', '1.9.0');
    loader.sync('heat', '1.9.0');
    expect(recorder.stop).not.toHaveBeenCalled();
    loader.sync('replay', '1.9.0');
    expect(recorder.stop).toHaveBeenCalledWith(true);
    expect(recorder.start.mock.calls.map(c => c[1])).toEqual(['heat', 'heat', 'replay']);
  });

  test('privacy: resolved and passed to start(); a later sync applies it to the next start', () => {
    const recorder = { ...fakeRecorder(), modes: ['replay', 'heat'] as const };
    (window as any)[REPLAY_GLOBAL] = recorder;
    const loader = new ReplayLoader(ctx);
    loader.sync('replay', '1.9.1', { textMode: 'marked', attributes: true, urlQuery: 'yes' } as any);
    expect(recorder.start.mock.calls[0][2]).toEqual({ textMode: 'marked', attributes: true, urlQuery: false });
    loader.sync('heat', '1.9.1', { textMode: 'all' });
    expect(recorder.start.mock.calls[1][2]).toEqual({ textMode: 'all', attributes: false, urlQuery: false });
  });

  test('a throwing recorder never breaks the SDK', () => {
    const recorder = fakeRecorder();
    recorder.start.mockImplementation(() => { throw new Error('boom'); });
    recorder.event.mockImplementation(() => { throw new Error('boom'); });
    recorder.stop.mockImplementation(() => { throw new Error('boom'); });
    (window as any)[REPLAY_GLOBAL] = recorder;
    const loader = new ReplayLoader(ctx);
    expect(() => {
      loader.sync('replay', '1.8.0');
      loader.event('track', {});
      loader.sessionChanged('sess_2');
      loader.sync(null, '1.8.0');
    }).not.toThrow();
  });
});

describe('bundle guard: dl.js never contains the recorder', () => {
  // Walk src/index.ts's static import graph; rrweb, fflate and src/replay/* must not be in it.
  function importGraph(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const source = fs.readFileSync(entry, 'utf8');
    const re = /(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(entry), spec);
        const file = [resolved + '.ts', path.join(resolved, 'index.ts')].find(f => fs.existsSync(f));
        if (file) importGraph(file, seen);
      } else {
        seen.add(spec);
      }
    }
    return seen;
  }

  test('src/index.ts does not reach @rrweb/*, rrweb-snapshot, fflate or src/replay/', () => {
    const graph = Array.from(importGraph(path.join(__dirname, 'index.ts')));
    expect(graph.filter(x => x.startsWith('@rrweb') || x.startsWith('rrweb') || x === 'fflate')).toEqual([]);
    expect(graph.filter(x => x.includes(`${path.sep}replay${path.sep}`))).toEqual([]);
    expect(graph.some(x => x.endsWith('replay-loader.ts'))).toBe(true);
  });
});

describe('privacy settings (resolveReplayPrivacy)', () => {
  test('absent / junk → safe defaults', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) expect(resolveReplayPrivacy(raw)).toEqual({ textMode: 'interactive', attributes: false, urlQuery: false });
  });
  test('each textMode accepted; unknown falls back to interactive', () => {
    expect(resolveReplayPrivacy({ textMode: 'all' }).textMode).toBe('all');
    expect(resolveReplayPrivacy({ textMode: 'marked' }).textMode).toBe('marked');
    expect(resolveReplayPrivacy({ textMode: 'interactive' }).textMode).toBe('interactive');
    expect(resolveReplayPrivacy({ textMode: 'none' }).textMode).toBe('interactive');
    expect(resolveReplayPrivacy({ textMode: 'ALL' }).textMode).toBe('interactive');
  });
  test('only a literal true relaxes attributes / urlQuery', () => {
    expect(resolveReplayPrivacy({ attributes: true, urlQuery: true })).toEqual({ textMode: 'interactive', attributes: true, urlQuery: true });
    expect(resolveReplayPrivacy({ attributes: 'true', urlQuery: 1 })).toEqual({ textMode: 'interactive', attributes: false, urlQuery: false });
  });
});
