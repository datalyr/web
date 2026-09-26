/**
 * Session replay wired into the SDK (index.ts syncReplay): enabled only by the dashboard
 * config from /container-scripts, stopped and discarded at every site that changes
 * whether tracking is allowed (the same sites as the in-app handoff).
 */
export {};

type SdkModule = typeof import('./index');
function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

const ENABLED = { replay: { enabled: true, sampleRate: 1, v: '1.8.3' } };

function mockNetwork(remoteConfig?: Record<string, unknown>): jest.Mock {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/container-scripts')) {
      return {
        ok: true, status: 200,
        json: async () => ({ scripts: [], pixels: null, ...(remoteConfig ? { config: remoteConfig } : {}) }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

const BASE = {
  workspaceId: 'ws_replay_test',
  enableFingerprinting: false,
  enablePerformanceTracking: false,
  trackPageViews: false,
  stripePaymentLinks: false,
  stripeCheckoutSessions: false,
  inAppHandoff: false,
};

const replayScripts = () => Array.from(document.querySelectorAll('script')).filter(s => s.src.includes('/dl.replay.'));

function fakeRecorder() {
  const recorder = {
    start: jest.fn(), stop: jest.fn(), event: jest.fn(), sessionChanged: jest.fn(), isRecording: jest.fn(() => true),
  };
  (window as any).DatalyrReplay = recorder;
  return recorder;
}

async function boot(remote: Record<string, unknown> | undefined, config: Record<string, unknown> = {}) {
  mockNetwork(remote);
  const sdk = loadSdk().createDatalyrInstance();
  sdk.init({ ...BASE, ...config } as any);
  await sdk.ready();
  await settle();
  return sdk;
}

describe('session replay in the SDK', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    document.cookie.split(';').forEach(c => {
      const name = c.split('=')[0].trim();
      if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    replayScripts().forEach(s => s.remove());
    delete (window as any).DatalyrReplay;
    delete (window as any).datalyr;
    delete (navigator as any).globalPrivacyControl;
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  test('dashboard enabled → loads the versioned module from track.datalyr.com and starts it', async () => {
    const sdk = await boot(ENABLED);
    const scripts = replayScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe('https://track.datalyr.com/dl.replay.1.8.3.js');
    expect(scripts[0].hasAttribute('crossorigin')).toBe(false);

    const recorder = fakeRecorder();
    scripts[0].onload!(new Event('load'));
    expect(recorder.start).toHaveBeenCalledTimes(1);
    const ctx = recorder.start.mock.calls[0][0];
    expect(ctx.workspaceId).toBe('ws_replay_test');
    expect(ctx.endpoint).toBe('https://replay.datalyr.com/replay');
    expect(ctx.getSessionId()).toBe(sdk.getSessionId());
    expect(ctx.getVisitorId()).toBe(sdk.getAnonymousId());

    sdk.track('add_to_cart', { value: 30, currency: 'GBP', product_id: 'p9', email: 'jane@example.com' });
    expect(recorder.event).toHaveBeenCalledWith('track', { name: 'add_to_cart', value: 30, currency: 'GBP', product_id: 'p9' });
    sdk.destroy();
    expect(recorder.stop).toHaveBeenCalledWith(true);
  });

  test.each<[string, Record<string, unknown> | undefined, Record<string, unknown>]>([
    ['no replay key in the remote config', { autoIdentify: false }, {}],
    ['no remote config at all', undefined, {}],
    ['dashboard disabled', { replay: { enabled: false, sampleRate: 1 } }, {}],
    ['init replay:false beats the dashboard', ENABLED, { replay: false }],
    ['init cannot enable it', undefined, { replay: { enabled: true, sampleRate: 1 } }],
    ['privacyMode strict', ENABLED, { privacyMode: 'strict' }],
    ['container disabled (no remote config)', ENABLED, { enableContainer: false }],
  ])('%s → no module', async (_label, remote, config) => {
    const sdk = await boot(remote, config);
    expect(replayScripts()).toHaveLength(0);
    sdk.destroy();
  });

  test('Do Not Track and GPC keep replay off even when the site does not honor them for analytics', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const dnt = await boot(ENABLED, { respectDoNotTrack: false });
    expect(replayScripts()).toHaveLength(0);
    dnt.destroy();
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });

    (navigator as any).globalPrivacyControl = true;
    const gpc = await boot(ENABLED, { respectGlobalPrivacyControl: false });
    expect(replayScripts()).toHaveLength(0);
    gpc.destroy();
  });

  test('persisted marketing decline at init → no module', async () => {
    const sdk = loadSdk().createDatalyrInstance();
    sdk.setConsent({ analytics: true, marketing: false } as any);
    mockNetwork(ENABLED);
    sdk.init(BASE as any);
    await sdk.ready();
    await settle();
    expect(replayScripts()).toHaveLength(0);
    sdk.destroy();
  });

  test.each<[string, (sdk: any) => void]>([
    ['optOut', sdk => sdk.optOut()],
    ['setConsent analytics:false', sdk => sdk.setConsent({ analytics: false })],
    ['setConsent marketing:false', sdk => sdk.setConsent({ analytics: true, marketing: false })],
  ])('%s → stop and discard', async (_label, act) => {
    const recorder = fakeRecorder(); // already registered: started without a script
    const sdk = await boot(ENABLED);
    expect(recorder.start).toHaveBeenCalled(); // start() is idempotent in the recorder
    act(sdk);
    expect(recorder.stop).toHaveBeenCalledWith(true);
    sdk.track('after', {});
    expect(recorder.event).not.toHaveBeenCalledWith('track', expect.objectContaining({ name: 'after' }));
    sdk.destroy();
  });

  test('optIn after optOut does not restart it on this page', async () => {
    const recorder = fakeRecorder();
    const sdk = await boot(ENABLED);
    const starts = recorder.start.mock.calls.length;
    sdk.optOut();
    // optOut drops the container (and with it the remote config) for this page:
    // replay resumes on the next load, like the pixels.
    sdk.optIn();
    expect(recorder.start).toHaveBeenCalledTimes(starts);
    sdk.destroy();
  });

  test('reset discards the previous user\'s recording and starts a fresh one', async () => {
    const recorder = fakeRecorder();
    const sdk = await boot(ENABLED);
    const starts = recorder.start.mock.calls.length;
    sdk.reset();
    expect(recorder.stop).toHaveBeenCalledWith(true);
    expect(recorder.stop.mock.invocationCallOrder[0]).toBeLessThan(recorder.start.mock.invocationCallOrder[starts]);
    expect(recorder.start.mock.calls.length).toBeGreaterThan(starts);
    sdk.destroy();
  });

  test('a new session is handed to the recorder', async () => {
    const recorder = fakeRecorder();
    const sdk = await boot(ENABLED);
    const next = sdk.startNewSession();
    expect(recorder.sessionChanged).toHaveBeenCalledWith(next);
    sdk.destroy();
  });

  test('SPA navigation writes a url event', async () => {
    const recorder = fakeRecorder();
    const sdk = await boot(ENABLED);
    window.history.pushState({}, '', '/products/ring');
    await settle();
    expect(recorder.event).toHaveBeenCalledWith('url', { href: expect.stringContaining('/products/ring') });
    sdk.destroy();
  });
});
