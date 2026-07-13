type SdkModule = typeof import('./index');

function loadSdk(): SdkModule {
  let sdk!: SdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as SdkModule;
  });
  return sdk;
}

describe('Datalyr instance factory and global singleton', () => {
  beforeEach(() => {
    delete (window as any).datalyr;
  });

  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
  });

  it('preserves an existing window singleton when the module loads', () => {
    const existing = { marker: 'existing-sdk' };
    (window as any).datalyr = existing;

    const sdk = loadSdk();

    expect(sdk.datalyr).toBe(existing);
    expect((window as any).datalyr).toBe(existing);
  });

  it('creates and publishes the default singleton when none exists', () => {
    const sdk = loadSdk();

    expect((window as any).datalyr).toBe(sdk.datalyr);
    expect(sdk.datalyr.getWorkspaceId()).toBeNull();
  });

  it('creates independent instances without mutating window.datalyr', () => {
    const sdk = loadSdk();
    const singleton = (window as any).datalyr;

    const independent = sdk.createDatalyrInstance();

    expect(independent).not.toBe(sdk.datalyr);
    expect(independent.getWorkspaceId()).toBeNull();
    expect((window as any).datalyr).toBe(singleton);
  });

  it('reports the workspace configured by init()', async () => {
    const sdk = loadSdk();
    const independent = sdk.createDatalyrInstance();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    independent.init({
      workspaceId: 'workspace-factory-test',
      enableContainer: false,
      enableFingerprinting: false,
      enablePerformanceTracking: false,
      trackPageViews: false,
      trackSPA: false,
      stripePaymentLinks: false,
    });
    await independent.ready();

    expect(independent.getWorkspaceId()).toBe('workspace-factory-test');
    independent.destroy();
  });
});
