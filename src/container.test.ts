import { ContainerManager } from './container';

describe('Whop Pixel container integration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete (window as any).whop;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  test('initializes the official Whop Pixel and forwards page views', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        scripts: [],
        pixels: {
          whop: { enabled: true, company_id: 'biz_test' },
        },
      }),
    }) as unknown as typeof fetch;

    const manager = new ContainerManager({ workspaceId: 'site_test' });
    await manager.init();

    expect((window as any).whop).toBeDefined();
    expect((window as any).whop.s).toEqual(['biz_test']);
    expect(
      Array.from(document.querySelectorAll('script')).some(
        (script) => script.src === 'https://t.whop.tw/s.js',
      ),
    ).toBe(true);

    manager.trackToPixels('pageview');
    expect(
      (window as any).whop.q.some((entry: unknown[]) => entry[1] === 'page'),
    ).toBe(true);
  });
});
