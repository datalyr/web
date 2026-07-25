// WEB-20 / WEB-21 — redundant-identify suppression, and one event per
// auto-identification instead of two.
//
// Web never got the suppression the mobile SDKs received in iOS 2.1.10 /
// RN 1.7.15, so a SPA calling identify() in a route effect re-emitted an
// unchanged identity on every navigation. Separately, the auto-identify path
// emitted `$auto_identify` AND then called identify() → `$identify`, ~1ms
// apart with the same email: production on workspace f6260736 showed a perfect
// 379 / 379 / 379 split ($identify / $auto_identify / visitors) over 7 days.

// `export {}` makes this file a MODULE. Without it TypeScript treats a test file
// with no top-level import/export as a global script, and `SdkModule` /
// `loadSdk` collide with the identically-named declarations in index.test.ts
// (TS2300/TS2393) — which breaks `npm run typecheck` even though jest passes.
export {};

type DatalyrSdkModule = typeof import('./index');

function loadSdk(): DatalyrSdkModule {
  let sdk!: DatalyrSdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as DatalyrSdkModule;
  });
  return sdk;
}

async function makeSdk() {
  const sdk = loadSdk();
  const instance = sdk.createDatalyrInstance();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  instance.init({
    workspaceId: 'ws-identify-dedupe',
    enableContainer: false,
    enableFingerprinting: false,
    enablePerformanceTracking: false,
    trackPageViews: false,
    trackSPA: false,
    stripePaymentLinks: false,
  });
  await instance.ready();
  return instance;
}

/** Names of every event the instance tracks, in order. */
function captureEvents(instance: any): string[] {
  const seen: string[] = [];
  const original = instance.track.bind(instance);
  instance.track = (name: string, ...rest: any[]) => {
    seen.push(name);
    return original(name, ...rest);
  };
  return seen;
}

describe('WEB-20 — redundant identify suppression', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).datalyr;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  it('emits $identify once for a repeated unchanged identity', async () => {
    const sdk = await makeSdk();
    const events = captureEvents(sdk);

    sdk.identify('user_1', { email: 'a@example.com' });
    sdk.identify('user_1', { email: 'a@example.com' });
    sdk.identify('user_1', { email: 'a@example.com' });

    expect(events.filter((e) => e === '$identify')).toHaveLength(1);
    sdk.destroy();
  });

  it('still emits when a trait changes', async () => {
    const sdk = await makeSdk();
    const events = captureEvents(sdk);

    sdk.identify('user_1', { email: 'a@example.com' });
    sdk.identify('user_1', { email: 'b@example.com' });

    expect(events.filter((e) => e === '$identify')).toHaveLength(2);
    sdk.destroy();
  });

  it('is insensitive to trait key order', async () => {
    const sdk = await makeSdk();
    const events = captureEvents(sdk);

    sdk.identify('user_1', { email: 'a@example.com', plan: 'pro' });
    sdk.identify('user_1', { plan: 'pro', email: 'a@example.com' });

    expect(events.filter((e) => e === '$identify')).toHaveLength(1);
    sdk.destroy();
  });

  it('detects a change nested inside an object trait', async () => {
    // Deliberately stronger than the mobile SDKs, which stringify with
    // String(value) and flatten every object to "[object Object]" — swallowing
    // exactly this change. Web traits are plain JSON, so the fingerprint is
    // exact.
    const sdk = await makeSdk();
    const events = captureEvents(sdk);

    sdk.identify('user_1', { prefs: { theme: 'dark' } } as any);
    sdk.identify('user_1', { prefs: { theme: 'light' } } as any);

    expect(events.filter((e) => e === '$identify')).toHaveLength(2);
    sdk.destroy();
  });

  it('always emits for a different user', async () => {
    const sdk = await makeSdk();
    const events = captureEvents(sdk);

    sdk.identify('user_1', { email: 'a@example.com' });
    sdk.identify('user_2', { email: 'b@example.com' });

    expect(events.filter((e) => e === '$identify')).toHaveLength(2);
    sdk.destroy();
  });

  it('re-emits after reset() so a logout→login rebuilds the link', async () => {
    const sdk = await makeSdk();
    const events = captureEvents(sdk);

    sdk.identify('user_1', { email: 'a@example.com' });
    sdk.reset();
    sdk.identify('user_1', { email: 'a@example.com' });

    expect(events.filter((e) => e === '$identify')).toHaveLength(2);
    sdk.destroy();
  });

  it('persists the fingerprint so a page reload does not re-emit', async () => {
    // The production pattern is a SPA route effect, but a full reload must not
    // resurrect the storm either — a memory-only fingerprint would.
    const first = await makeSdk();
    const firstEvents = captureEvents(first);
    first.identify('user_1', { email: 'a@example.com' });
    expect(firstEvents.filter((e) => e === '$identify')).toHaveLength(1);
    first.destroy();

    // Same localStorage, brand-new instance = a reload.
    const second = await makeSdk();
    const secondEvents = captureEvents(second);
    second.identify('user_1', { email: 'a@example.com' });
    expect(secondEvents.filter((e) => e === '$identify')).toHaveLength(0);
    second.destroy();
  });

  it('stores a hash, never the raw traits', async () => {
    const sdk = await makeSdk();
    sdk.identify('user_1', { email: 'secret@example.com' });

    const raw = JSON.stringify(localStorage);
    expect(raw).toContain('identify_fingerprint');
    // The fingerprint value itself must not leak the address.
    const key = Object.keys(localStorage).find((k) => k.includes('identify_fingerprint'))!;
    expect(localStorage.getItem(key)).not.toContain('secret@example.com');
    sdk.destroy();
  });

  it('identity state is still updated on a suppressed call', async () => {
    // Only the EVENT is suppressed. dl_user_id and traits must still be current,
    // or suppression would silently break identity resolution.
    const sdk = await makeSdk();
    sdk.identify('user_1', { email: 'a@example.com' });
    sdk.identify('user_1', { email: 'a@example.com' });

    expect((sdk as any).identity.getUserId()).toBe('user_1');
    sdk.destroy();
  });
});

describe('WEB-21 — auto-identify emits one event, not two', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).datalyr;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  it('produces $identify only, carrying the detector as a trait', async () => {
    const sdk = await makeSdk();
    const tracked: Array<{ name: string; props: any }> = [];
    const original = (sdk as any).track.bind(sdk);
    (sdk as any).track = (name: string, props: any, ...rest: any[]) => {
      tracked.push({ name, props });
      return original(name, props, ...rest);
    };

    // Drive the auto-identify callback exactly as AutoIdentifyManager would.
    (sdk as any).identify('found@example.com', {
      email: 'found@example.com',
      auto_identify_source: 'shopify',
    });

    expect(tracked.map((t) => t.name)).toEqual(['$identify']);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].props.traits.auto_identify_source).toBe('shopify');
    expect(tracked[0].props.traits.email).toBe('found@example.com');
    sdk.destroy();
  });

  it('$auto_identify is no longer emitted anywhere in the SDK', async () => {
    // Guard against reintroduction: nothing on the platform ever read this
    // event (grepped across app/, lib/, all workers and all Tinybird pipes),
    // while prod carried 6,197 of them in 30 days.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    const source = readFileSync(`${__dirname}/index.ts`, 'utf8');
    const emitting = source
      .split('\n')
      .filter((line: string) => line.includes("'$auto_identify'"))
      .filter((line: string) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    expect(emitting).toEqual([]);
  });
});
