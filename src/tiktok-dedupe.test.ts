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

  /**
   * The other half of TikTok's dedup key is the event NAME, and the Events API
   * sender takes it from the conversion rule (`rule.platform_event_name ||
   * event.event_name`). The rule map now reaches the browser as
   * pixels.tiktok.event_mappings, so it has to win over the SDK's static default
   * — otherwise a renamed rule sends CompletePayment from the server and
   * PlaceAnOrder from the browser, and neither copy dedupes.
   */
  describe('event name resolution matches the Events API sender', () => {
    async function nameFor(ours: string, tiktokConfig: Record<string, unknown>): Promise<string> {
      const config = { tiktok: { ...pixels.tiktok, ...tiktokConfig } };
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pixels: config }) }) as any;
      (manager as any).pixels = config;
      ttq.track.mockClear();
      await manager.trackToPixels(ours, {}, 'id');
      expect(ttq.track).toHaveBeenCalledTimes(1);
      return ttq.track.mock.calls[0][0];
    }

    test('a rule overrides the static default for that event', async () => {
      expect(await nameFor('purchase', {})).toBe('CompletePayment');
      expect(await nameFor('purchase', { event_mappings: { purchase: 'PlaceAnOrder' } })).toBe('PlaceAnOrder');
    });

    test('a rule for a custom event name is used verbatim', async () => {
      expect(await nameFor('quiz_done', { event_mappings: { quiz_done: 'SubmitForm' } })).toBe('SubmitForm');
    });

    test('the static default still applies to events the rule map does not cover', async () => {
      const event_mappings = { purchase: 'PlaceAnOrder' };
      expect(await nameFor('add_to_cart', { event_mappings })).toBe('AddToCart');
      // An empty map (what a fail-open DB error in /container-scripts yields)
      // must leave the static default in charge, not blank the name.
      expect(await nameFor('add_to_cart', { event_mappings: {} })).toBe('AddToCart');
      expect(await nameFor('add_to_cart', {})).toBe('AddToCart');
    });

    test('an uncovered custom event falls through to the sanitized raw name', async () => {
      expect(await nameFor('quiz_done', { event_mappings: { purchase: 'PlaceAnOrder' } })).toBe('quiz_done');
    });

    test('the rule map is keyed on the exact trigger name the rule stores', async () => {
      // /container-scripts keys it by trigger_event_name verbatim, so a differently
      // cased key is not a match and the static default takes over.
      expect(await nameFor('purchase', { event_mappings: { Purchase: 'PlaceAnOrder' } })).toBe('CompletePayment');
    });
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
