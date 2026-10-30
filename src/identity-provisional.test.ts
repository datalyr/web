// §2.10 provisional (pre-login) ids, and auto-identify never running the
// account-switch reset on an identified page.
//
// The server converts a provisional user id into the first real account on the
// same visitor id (datalyr-v2 docs/identity-resolution/provisional-conversion.md).
// That only works if the SDK keeps the visitor id when the real id follows, and
// marks the guest id on the wire (`event_data.$provisional_user_id`).
export {};

type DatalyrSdkModule = typeof import('./index');

let autoIdentifyCallback: ((email: string, source: string) => void) | null = null;

function loadSdk(): DatalyrSdkModule {
  let sdk!: DatalyrSdkModule;
  jest.isolateModules(() => {
    jest.doMock('./auto-identify', () => ({
      AutoIdentifyManager: class {
        initialize(cb: (email: string, source: string) => void) { autoIdentifyCallback = cb; }
        destroy() { /* noop */ }
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as DatalyrSdkModule;
  });
  return sdk;
}

async function makeSdk(extra: Record<string, unknown> = {}) {
  const sdk = loadSdk();
  const instance = sdk.createDatalyrInstance();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  instance.init({
    workspaceId: 'ws-provisional',
    enableContainer: false,
    enableFingerprinting: false,
    enablePerformanceTracking: false,
    trackPageViews: false,
    trackSPA: false,
    stripePaymentLinks: false,
    ...extra,
  } as any);
  await instance.ready();
  return instance;
}

/** Every event the instance builds, as the server would receive it. */
function capturePayloads(instance: any): Array<{ name: string; data: any; userId: any }> {
  const seen: Array<{ name: string; data: any; userId: any }> = [];
  const original = instance.createEventPayload.bind(instance);
  instance.createEventPayload = (name: string, ...rest: any[]) => {
    const payload = original(name, ...rest);
    seen.push({ name, data: payload.event_data, userId: payload.user_id });
    return payload;
  };
  return seen;
}

describe('§2.10 provisional identify', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).datalyr;
    autoIdentifyCallback = null;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  it('marks every event while the provisional id is current', async () => {
    const sdk = await makeSdk();
    const events = capturePayloads(sdk);

    sdk.identify('7c9e6679-7425-40de-944b-e07fc1f90ae7', {}, { provisional: true });
    sdk.track('screen_a');

    expect(events.map((e) => e.name)).toEqual(['$identify', 'screen_a']);
    for (const e of events) {
      expect(e.data.$provisional_user_id).toBe(true);
      expect(e.userId).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    }
    sdk.destroy();
  });

  it('keeps the visitor id when the real account follows, and stops marking', async () => {
    const sdk = await makeSdk();
    const events = capturePayloads(sdk);
    const resetSpy = jest.spyOn(sdk, 'reset');

    sdk.identify('guest-uuid', {}, { provisional: true });
    const visitor = sdk.getAnonymousId();
    sdk.identify('firebase_uid_123');
    sdk.track('after_login');

    expect(resetSpy).not.toHaveBeenCalled();
    expect(sdk.getAnonymousId()).toBe(visitor);
    const login = events.filter((e) => e.name === '$identify')[1];
    expect(login.userId).toBe('firebase_uid_123');
    expect(login.data.$provisional_user_id).toBeUndefined();
    expect(events.find((e) => e.name === 'after_login')!.data.$provisional_user_id).toBeUndefined();
    expect(events.map((e) => e.name)).not.toContain('$alias');
    sdk.destroy();
  });

  it('never replaces a signed-in user with a provisional id', async () => {
    const sdk = await makeSdk();
    const events = capturePayloads(sdk);

    sdk.identify('acct_1');
    const visitor = sdk.getAnonymousId();
    sdk.identify('guest-uuid', {}, { provisional: true });
    sdk.track('later');

    expect(sdk.getAnonymousId()).toBe(visitor);
    expect(events.filter((e) => e.name === '$identify')).toHaveLength(1);
    expect(events.find((e) => e.name === 'later')!.userId).toBe('acct_1');
    expect(events.find((e) => e.name === 'later')!.data.$provisional_user_id).toBeUndefined();
    sdk.destroy();
  });

  it('a real account switch still resets', async () => {
    const sdk = await makeSdk();
    sdk.identify('acct_1');
    const visitor = sdk.getAnonymousId();
    sdk.identify('acct_2');
    expect(sdk.getAnonymousId()).not.toBe(visitor);
    sdk.destroy();
  });

  it('reset() clears the provisional state', async () => {
    const sdk = await makeSdk();
    const events = capturePayloads(sdk);
    sdk.identify('guest-uuid', {}, { provisional: true });
    expect(localStorage.getItem('dl_dl_user_id_kind')).not.toBeNull();
    sdk.reset();
    sdk.track('anon');
    expect(events.find((e) => e.name === 'anon')!.data.$provisional_user_id).toBeUndefined();
    expect(localStorage.getItem('dl_dl_user_id_kind')).toBeNull();
    sdk.destroy();
  });

  it('survives a reload (kind is persisted with the id)', async () => {
    const first = await makeSdk();
    first.identify('guest-uuid', {}, { provisional: true });
    const visitor = first.getAnonymousId();
    first.destroy();
    delete (window as any).datalyr;

    const second = await makeSdk();
    const events = capturePayloads(second);
    second.track('relaunch');
    expect(events[0].userId).toBe('guest-uuid');
    expect(events[0].data.$provisional_user_id).toBe(true);
    second.identify('real_account');
    expect(second.getAnonymousId()).toBe(visitor);
    second.destroy();
  });

  it('a provisional identify after the same real id is not redundant-suppressed into the wrong kind', async () => {
    const sdk = await makeSdk();
    const events = capturePayloads(sdk);
    sdk.identify('guest-uuid', {}, { provisional: true });
    sdk.identify('guest-uuid'); // the app promotes the same id to an account
    sdk.track('x');
    expect(events.filter((e) => e.name === '$identify')).toHaveLength(2);
    expect(events.find((e) => e.name === 'x')!.data.$provisional_user_id).toBeUndefined();
    sdk.destroy();
  });
});

describe('auto-identify on an identified page', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).datalyr;
    autoIdentifyCallback = null;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  it('does not reset or replace a signed-in user', async () => {
    const sdk = await makeSdk({ autoIdentify: true });
    expect(autoIdentifyCallback).not.toBeNull();
    const events = capturePayloads(sdk);
    const resetSpy = jest.spyOn(sdk, 'reset');

    sdk.identify('acct_1');
    const visitor = sdk.getAnonymousId();
    autoIdentifyCallback!('someone@example.com', 'form');
    sdk.track('after');

    expect(resetSpy).not.toHaveBeenCalled();
    expect(sdk.getAnonymousId()).toBe(visitor);
    expect(events.find((e) => e.name === 'after')!.userId).toBe('acct_1');
    sdk.destroy();
  });

  it('an explicit login after an auto-identified email keeps the visitor', async () => {
    const sdk = await makeSdk({ autoIdentify: true });
    const resetSpy = jest.spyOn(sdk, 'reset');

    autoIdentifyCallback!('lead@example.com', 'form');
    const visitor = sdk.getAnonymousId();
    sdk.identify('acct_9');

    expect(resetSpy).not.toHaveBeenCalled();
    expect(sdk.getAnonymousId()).toBe(visitor);
    sdk.destroy();
  });

  it('a guest (provisional) visitor still takes the captured email', async () => {
    const sdk = await makeSdk({ autoIdentify: true });
    const events = capturePayloads(sdk);
    sdk.identify('guest-uuid', {}, { provisional: true });
    const visitor = sdk.getAnonymousId();
    autoIdentifyCallback!('lead@example.com', 'form');
    const last = events.filter((e) => e.name === '$identify').pop()!;
    expect(last.userId).toBe('lead@example.com');
    expect(last.data.$provisional_user_id).toBeUndefined();
    expect(sdk.getAnonymousId()).toBe(visitor);
    sdk.destroy();
  });
});
