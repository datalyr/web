/**
 * W13: the getters read the identity / session / attribution / queue managers that
 * init() creates, so calling one before init() threw a TypeError into the caller
 * (for example a checkout handler calling getStripeMetadata() before the snippet ran
 * init()). They now warn once and return the empty value, like the tracking methods.
 */
export {}; // a module, so SdkModule does not clash with index.test.ts's global one

type SdkModule = typeof import('./index');

function freshInstance(): ReturnType<SdkModule['createDatalyrInstance']> {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk.createDatalyrInstance();
}

afterEach(() => {
  delete (window as any).datalyr;
  jest.restoreAllMocks();
});

describe('getters before init()', () => {
  const cases: Array<[string, (sdk: ReturnType<typeof freshInstance>) => unknown, unknown]> = [
    ['getAnonymousId', (sdk) => sdk.getAnonymousId(), ''],
    ['getVisitorId', (sdk) => sdk.getVisitorId(), ''],
    ['getDistinctId', (sdk) => sdk.getDistinctId(), ''],
    ['getUserId', (sdk) => sdk.getUserId(), null],
    ['getSessionId', (sdk) => sdk.getSessionId(), ''],
    ['getSessionData', (sdk) => sdk.getSessionData(), null],
    ['getStripeMetadata', (sdk) => sdk.getStripeMetadata(), { client_reference_id: '', metadata: { visitor_id: '' } }],
    ['getWhopCheckoutMetadata', (sdk) => sdk.getWhopCheckoutMetadata(), { visitor_id: '' }],
    ['getAttribution', (sdk) => sdk.getAttribution(), {}],
    ['getJourney', (sdk) => sdk.getJourney(), []],
    ['getNetworkStatus', (sdk) => sdk.getNetworkStatus(), { isOnline: navigator.onLine, lastOfflineAt: null, lastOnlineAt: null }],
  ];

  test.each(cases)('%s does not throw and returns the empty value', (_name, call, empty) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = freshInstance();
    expect(() => call(sdk)).not.toThrow();
    expect(call(sdk)).toEqual(empty);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('before init()');
  });

  test('the warning is printed once per instance, however many getters are called', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = freshInstance();
    for (const [, call] of cases) call(sdk);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('getters that already handled the missing manager are unchanged', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = freshInstance();
    expect(sdk.getWorkspaceId()).toBeNull();
    expect(sdk.getQueueStats()).toBeNull();
    expect(sdk.getLoadedScripts()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
