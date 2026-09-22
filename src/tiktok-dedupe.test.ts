/**
 * TikTok browser/server deduplication.
 *
 * TikTok collapses a Pixel event against an Events API event only when BOTH the
 * event name and the event_id parameter are identical (48h window, the first
 * copy received wins) — "About Event Deduplication", TikTok Ads Manager. The
 * browser carries the id as the third positional argument of the Pixel SDK's
 * track call: ttq.track(event, properties, { event_id }).
 *
 * The id has to be the SDK's per-event uuid, because that is the value the
 * ingested event carries as `event_id` and therefore the value the postback
 * worker sends (infra/cloudflare/postback/platforms/tiktok.js:
 * `event_id: event.event_id || event.id`). These tests pin both halves: the
 * browser call shape, and that the id equals the one on the ingested payload.
 */
export {}; // module scope: index.test.ts declares the same helper names globally

import { ContainerManager } from './container';

type SdkModule = typeof import('./index');

const TIKTOK_PIXEL = 'CJKL8MBC77UA0GVQ0KLG';

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

describe('TikTok Pixel mirror carries the Events API dedup id', () => {
  const originalFetch = global.fetch;
  const pixels = { tiktok: { enabled: true, pixel_id: TIKTOK_PIXEL } };
  let manager: ContainerManager;
  let ttq: { track: jest.Mock };

  beforeEach(() => {
    manager = new ContainerManager({ workspaceId: 'workspace' });
    // Loaded vendor boundary: vendor internals are deliberately not simulated.
    (manager as any).pixels = pixels;
    ttq = { track: jest.fn() };
    (window as any).ttq = ttq;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pixels }) }) as any;
  });

  afterEach(() => {
    manager.cleanupAllIframes();
    global.fetch = originalFetch;
    delete (window as any).ttq;
  });

  test('a mapped conversion fires with the TikTok standard name and { event_id }', async () => {
    expect(await manager.trackToPixels('purchase', { value: 12, currency: 'EUR' }, 'shared-id')).toEqual(['tiktok']);
    // event AND event_id must both match the server copy, or TikTok counts twice.
    expect(ttq.track).toHaveBeenCalledWith('CompletePayment', { value: 12, currency: 'EUR' }, { event_id: 'shared-id' });
  });

  test.each([
    ['add_to_cart', 'AddToCart'],
    ['checkout_started', 'InitiateCheckout'],
    ['sign_up', 'CompleteRegistration'],
  ])('%s mirrors as %s with the shared id', async (ours, tiktokName) => {
    await manager.trackToPixels(ours, { value: 3 }, `id-${ours}`);
    expect(ttq.track).toHaveBeenCalledWith(tiktokName, { value: 3 }, { event_id: `id-${ours}` });
  });

  test('a workspace rule name still carries the id', async () => {
    const mapped = { tiktok: { ...pixels.tiktok, event_mappings: { purchase: 'PlaceAnOrder' } } };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pixels: mapped }) }) as any;
    (manager as any).pixels = mapped;
    await manager.trackToPixels('purchase', {}, 'rule-id');
    expect(ttq.track).toHaveBeenCalledWith('PlaceAnOrder', {}, { event_id: 'rule-id' });
  });

  test('without an event id the call keeps its two-argument shape', async () => {
    await manager.trackToPixels('add_to_cart', { value: 3 });
    expect(ttq.track).toHaveBeenCalledWith('AddToCart', { value: 3 });
  });

  test('the id the pixel gets is the event_id the sender reads off the ingested event', async () => {
    const instance: any = loadSdk().createDatalyrInstance();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    instance.init({
      workspaceId: 'workspace-tiktok-dedupe',
      enableContainer: false,
      enableFingerprinting: false,
      enablePerformanceTracking: false,
      trackPageViews: false,
      trackSPA: false,
      stripePaymentLinks: false,
    });
    await instance.ready();
    const enqueued: any[] = [];
    jest.spyOn(instance.queue, 'enqueue').mockImplementation((payload: any) => { enqueued.push(payload); });
    instance.container = manager;

    instance.track('purchase', { value: 40, currency: 'USD' });
    // trackToPixels is fire-and-forget behind an awaited policy read.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueued).toHaveLength(1);
    const ingestedEventId = enqueued[0].event_id;
    expect(typeof ingestedEventId).toBe('string');
    expect(ingestedEventId.length).toBeGreaterThan(0);
    // postback/platforms/tiktok.js sends `event_id: event.event_id || event.id`.
    expect(ttq.track).toHaveBeenCalledWith('CompletePayment', { value: 40, currency: 'USD' }, { event_id: ingestedEventId });
    instance.destroy();
  });
});
