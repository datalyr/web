/**
 * Emit side of the in-app handoff: the writer in index.ts. What matters is when a
 * visitor id is (and is NOT) in the address bar — consent gating, immediate removal
 * on withdrawal/reset, no manufactured pageviews, and clean teardown.
 */
import { IN_APP_HANDOFF_PARAM, IN_APP_HANDOFF_REFRESH_MS, parseInAppHandoff } from './in-app-handoff';

type SdkModule = typeof import('./index');
function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const INSTAGRAM = `${IOS} Mobile/15E148 Instagram 339.0.3.12.91`;
const SAFARI = `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`;
const realUa = window.navigator.userAgent;
const setUserAgent = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
const token = () => new URLSearchParams(window.location.search).get(IN_APP_HANDOFF_PARAM);

const BASE = {
  workspaceId: 'workspace-handoff-test',
  enableContainer: false,
  enableFingerprinting: false,
  enablePerformanceTracking: false,
  trackPageViews: false,
  stripePaymentLinks: false,
  stripeCheckoutSessions: false,
};

async function boot(config: Record<string, unknown> = {}) {
  const instance = loadSdk().createDatalyrInstance();
  instance.init({ ...BASE, ...config } as any);
  await instance.ready();
  return instance;
}

describe('in-app handoff writer', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.cookie.split(';').forEach(c => {
      const name = c.split('=')[0].trim();
      if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
    localStorage.clear();
    window.history.replaceState({}, '', '/landing?gclid=abc');
    setUserAgent(INSTAGRAM);
  });
  afterEach(() => {
    setUserAgent(realUa);
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete (window as any).datalyr;
  });

  test('inside Instagram the address bar carries a fresh token for THIS visitor, and other params survive', async () => {
    const sdk = await boot();
    expect(parseInAppHandoff(token(), Date.now())).toBe(sdk.getAnonymousId());
    expect(window.location.search).toContain('gclid=abc');
    sdk.destroy();
  });

  test('a real browser never writes one; the off switch never writes one', async () => {
    setUserAgent(SAFARI);
    const safari = await boot();
    expect(token()).toBeNull();
    safari.destroy();

    setUserAgent(INSTAGRAM);
    const disabled = await boot({ inAppHandoff: false });
    expect(token()).toBeNull();
    disabled.destroy();
  });

  test('opt-out removes the visitor id from the URL immediately, and opt-in brings it back', async () => {
    const sdk = await boot();
    expect(token()).not.toBeNull();
    sdk.optOut();
    expect(token()).toBeNull(); // not "within 30 seconds"
    expect(window.location.search).toContain('gclid=abc');
    sdk.optIn();
    expect(parseInAppHandoff(token(), Date.now())).toBe(sdk.getAnonymousId());
    sdk.destroy();
  });

  test('a visitor declined at init gets no token until consent is granted mid-session', async () => {
    const sdk = await boot();
    sdk.optOut();
    sdk.destroy();
    window.history.replaceState({}, '', '/landing');

    const declined = await boot(); // opt-out persisted -> shouldTrack() false at init
    expect(token()).toBeNull();
    declined.optIn();
    expect(token()).not.toBeNull();
    declined.destroy();
  });

  test('reset() swaps the token to the new visitor at once (never keeps the logged-out id)', async () => {
    const sdk = await boot();
    const before = sdk.getAnonymousId();
    sdk.reset();
    const after = sdk.getAnonymousId();
    expect(after).not.toBe(before);
    expect(parseInAppHandoff(token(), Date.now())).toBe(after);
    sdk.destroy();
  });

  test('token refreshes never manufacture a pageview', async () => {
    jest.useFakeTimers();
    const instance = loadSdk().createDatalyrInstance();
    const pageSpy = jest.spyOn(instance, 'page');
    instance.init({ ...BASE, trackSPA: true } as any);
    await instance.ready();
    const first = token();
    jest.setSystemTime(Date.now() + IN_APP_HANDOFF_REFRESH_MS + 1000);
    jest.advanceTimersByTime(IN_APP_HANDOFF_REFRESH_MS + 1000);
    expect(token()).not.toBe(first); // it did refresh
    jest.advanceTimersByTime(50);    // let any queued SPA handler run
    expect(pageSpy).not.toHaveBeenCalled();
    instance.destroy();
  });

  test('destroy() stops the timer and leaves no token behind', async () => {
    jest.useFakeTimers();
    const instance = loadSdk().createDatalyrInstance();
    instance.init(BASE as any);
    await instance.ready();
    expect(token()).not.toBeNull();
    instance.destroy();
    expect(token()).toBeNull();
    jest.advanceTimersByTime(IN_APP_HANDOFF_REFRESH_MS * 3);
    expect(token()).toBeNull();
    expect(window.location.search).toContain('gclid=abc');
  });
});
