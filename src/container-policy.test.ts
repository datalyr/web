import { ContainerManager } from './container';

describe('current workspace policy before SDK-controlled pixel calls', () => {
  const originalFetch = global.fetch;
  let manager: ContainerManager;
  const enabled = { meta: { enabled: true, pixel_id: 'meta' }, google: { enabled: true, tag_id: 'google' }, tiktok: { enabled: true, pixel_id: 'tiktok' } };
  beforeEach(() => {
    manager = new ContainerManager({ workspaceId: 'workspace' });
    // Loaded vendor boundary: vendor internals are deliberately not simulated.
    (manager as any).pixels = enabled;
    (window as any).fbq = jest.fn();
    (window as any).gtag = jest.fn();
    (window as any).ttq = { track: jest.fn() };
  });
  afterEach(() => {
    manager.cleanupAllIframes();
    global.fetch = originalFetch;
    delete (window as any).fbq;
    delete (window as any).gtag;
    delete (window as any).ttq;
    jest.useRealTimers();
  });
  function response(pixels: unknown) {
    return { ok: true, json: async () => ({ pixels }) };
  }
  function noCalls() {
    expect((window as any).fbq).not.toHaveBeenCalled();
    expect((window as any).gtag).not.toHaveBeenCalled();
    expect((window as any).ttq.track).not.toHaveBeenCalled();
  }
  test('allowed events retain mapped names, money and shared Meta dedup id; each event rechecks', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(enabled));
    expect(await manager.trackToPixels('purchase', { value: 12, currency: 'EUR' }, 'shared-id')).toEqual(['meta', 'google', 'tiktok']);
    expect((window as any).fbq).toHaveBeenCalledWith('trackSingle', 'meta', 'Purchase', { value: 12, currency: 'EUR' }, { eventID: 'shared-id' });
    await manager.trackToPixels('purchase');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: 'no-store', body: JSON.stringify({ workspaceId: 'workspace', purpose: 'pixel_forwarding' }) }));
  });
  test.each(['OrderCompleted', 'TrialBegan'])('configured custom money event %s uses trackSingleCustom with unchanged money and dedup ID', async mapped => {
    global.fetch = jest.fn().mockResolvedValue(response({ meta: { ...enabled.meta, event_mappings: { purchase: mapped } } }));
    expect(await manager.trackToPixels('purchase', { value: 12, currency: 'EUR' }, 'custom-shared-id')).toEqual(['meta']);
    expect((window as any).fbq).toHaveBeenCalledWith('trackSingleCustom', 'meta', mapped, { value: 12, currency: 'EUR' }, { eventID: 'custom-shared-id' });
  });
  test.each(['Purchase', 'StartTrial', 'Subscribe', 'PageView', 'Donate'])('configured standard event %s retains trackSingle', async mapped => {
    global.fetch = jest.fn().mockResolvedValue(response({ meta: { ...enabled.meta, event_mappings: { purchase: mapped } } }));
    await manager.trackToPixels('purchase', { value: 12, currency: 'EUR' });
    expect((window as any).fbq).toHaveBeenCalledWith('trackSingle', 'meta', mapped, { value: 12, currency: 'EUR' });
  });
  test('new restriction suppresses already initialized vendors', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ meta: { ...enabled.meta, enabled: false }, google: { ...enabled.google, enabled: false }, tiktok: { ...enabled.tiktok, enabled: false } }));
    expect(await manager.trackToPixels('purchase')).toEqual([]);
    noCalls();
  });
  test.each([null, {}, { meta: { enabled: 'true', pixel_id: 'meta' } }, { meta: { enabled: true, pixel_id: 'new-pixel' } }])('missing, invalid and changed destinations never reuse the old loader: %p', async pixels => {
    global.fetch = jest.fn().mockResolvedValue(response(pixels));
    expect(await manager.trackToPixels('purchase')).toEqual([]);
    noCalls();
  });
  test('failed policy reads suppress delivery', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('unavailable'));
    expect(await manager.trackToPixels('purchase')).toEqual([]);
    noCalls();
  });
  test('cleanup during policy lookup prevents delayed delivery', async () => {
    let resolve!: (value: unknown) => void;
    global.fetch = jest.fn(() => new Promise(done => { resolve = done; })) as any;
    const pending = manager.trackToPixels('purchase');
    manager.cleanupAllIframes();
    resolve(response(enabled));
    expect(await pending).toEqual([]);
    noCalls();
  });
  test('consent changes during the policy request stop forwarding without requiring cleanup', async () => {
    manager.cleanupAllIframes();
    let allowed = true;
    manager = new ContainerManager({ workspaceId: 'workspace', canForward: () => allowed });
    (manager as any).pixels = enabled;
    let release!: (value: unknown) => void;
    global.fetch = jest.fn(() => new Promise(resolve => { release = resolve; })) as any;
    const pending = manager.trackToPixels('purchase');
    allowed = false;
    release(response(enabled));
    expect(await pending).toEqual([]);
    noCalls();
  });
  test('caller mutations during authorization cannot alter the captured event', async () => {
    let release!: (value: unknown) => void;
    global.fetch = jest.fn(() => new Promise(resolve => { release = resolve; })) as any;
    const properties = { value: 12, currency: 'EUR', contents: [{ id: 'original' }] };
    const pending = manager.trackToPixels('purchase', properties, 'event');
    properties.value = 99;
    properties.contents[0].id = 'changed';
    release(response(enabled));
    await pending;
    expect((window as any).fbq).toHaveBeenCalledWith('trackSingle', 'meta', 'Purchase', {
      value: 12, currency: 'EUR', contents: [{ id: 'original' }],
    }, { eventID: 'event' });
  });
  test('withdrawal while preparing identity prevents Meta init and subsequent vendor loaders', async () => {
    manager.cleanupAllIframes();
    let allowed = true;
    manager = new ContainerManager({ workspaceId: 'workspace', canForward: () => allowed,
      getIdentity: () => { allowed = false; return { externalId: 'test-visitor' }; },
    });
    global.fetch = jest.fn().mockResolvedValue(response(enabled));
    const before = document.querySelectorAll('script[src]').length;
    await manager.init();
    noCalls();
    expect(document.querySelectorAll('script[src]').length).toBe(before);
  });
  test.each(['init', 'forward'])('%s deadline includes a stalled response body and ignores late permission', async mode => {
    jest.useFakeTimers();
    let finishBody!: (value: unknown) => void;
    const body = new Promise(resolve => { finishBody = resolve; });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => body });
    let settled = false;
    const pending = (mode === 'init' ? manager.init() : manager.trackToPixels('purchase'))
      .then(() => { settled = true; });
    // Let fetch headers resolve before expiring the complete-read deadline.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(true);
    noCalls();
    finishBody({ pixels: enabled });
    await pending;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    noCalls();
  });
  test('deadline aborts a stalled read without forwarding', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as any;
    const pending = manager.trackToPixels('purchase');
    jest.advanceTimersByTime(3000);
    expect(await pending).toEqual([]);
    noCalls();
  });
});
