/**
 * W14: src/pixels/index.ts (the dl.pixels.<v>.js entry) had no tests of its own.
 * These pin the module shape dl.js relies on, the platform lookup, the error
 * containment and the window registration.
 */
import { PIXELS_API, PIXELS_GLOBAL, DESTINATION_PIXEL_PLATFORMS } from './destination-pixels';
import type { PixelLoadContext, PixelTrackContext } from './destination-pixels';

type PixelsModule = typeof import('./pixels/index');

function loadPixels(): PixelsModule {
  let mod!: PixelsModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('./pixels/index') as PixelsModule;
  });
  return mod;
}

const loadCtx: PixelLoadContext = { readShopifyPixels: () => [], allowed: () => true, log: () => undefined };
const trackCtx: PixelTrackContext = { allowed: () => true };
const event = { name: 'purchase', properties: { value: 1 }, eventId: 'evt_1' };

afterEach(() => {
  delete (window as any)[PIXELS_GLOBAL];
  jest.restoreAllMocks();
});

describe('createPixelsModule', () => {
  test('exposes the contract version and one platform per served destination', () => {
    const mod = loadPixels().createPixelsModule();
    expect(mod.api).toBe(PIXELS_API);
    expect(mod.pixels_version).toBe(mod.version);
    expect(Object.keys(mod.platforms).sort()).toEqual([...DESTINATION_PIXEL_PLATFORMS].sort());
  });

  test('an unknown platform is blocked on load and not tracked', async () => {
    const mod = loadPixels().createPixelsModule();
    expect(await mod.load('pinterest' as any, {}, loadCtx)).toBe('blocked');
    expect(await mod.track('pinterest' as any, {}, event, trackCtx)).toBe(false);
  });

  test('inherited object keys are not treated as platforms', async () => {
    const mod = loadPixels().createPixelsModule();
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(await mod.load(key as any, {}, loadCtx)).toBe('blocked');
      expect(await mod.track(key as any, {}, event, trackCtx)).toBe(false);
    }
  });

  test('load and track are passed to the named platform with their arguments', async () => {
    const mod = loadPixels().createPixelsModule();
    const load = jest.spyOn(mod.platforms.x, 'load').mockResolvedValue('loaded');
    const track = jest.spyOn(mod.platforms.x, 'track').mockResolvedValue(true);
    const config = { pixel_id: 'abc' };

    expect(await mod.load('x', config, loadCtx)).toBe('loaded');
    expect(load).toHaveBeenCalledWith(config, loadCtx);
    expect(await mod.track('x', config, event, trackCtx)).toBe(true);
    expect(track).toHaveBeenCalledWith(config, event, trackCtx);
  });

  test('a platform that throws is contained: load gives blocked, track gives false', async () => {
    const mod = loadPixels().createPixelsModule();
    jest.spyOn(mod.platforms.linkedin, 'load').mockRejectedValue(new Error('boom'));
    jest.spyOn(mod.platforms.linkedin, 'track').mockImplementation(() => { throw new Error('boom'); });

    await expect(mod.load('linkedin', {}, loadCtx)).resolves.toBe('blocked');
    await expect(mod.track('linkedin', {}, event, trackCtx)).resolves.toBe(false);
  });
});

describe('window registration', () => {
  test('loading the module registers it on window', () => {
    loadPixels();
    const registered = (window as any)[PIXELS_GLOBAL];
    expect(registered).toBeDefined();
    expect(registered.api).toBe(PIXELS_API);
  });

  test('an existing registration is kept', () => {
    const existing = { api: PIXELS_API, marker: 'first copy' };
    (window as any)[PIXELS_GLOBAL] = existing;
    loadPixels();
    expect((window as any)[PIXELS_GLOBAL]).toBe(existing);
  });
});
