/**
 * FX-126: keep a DATALYR-signed Klaviyo link token (dlk1 / dlk2 shape only) for
 * the browser session and attach it to each later view_item / add_to_cart /
 * checkout_started, so ingest can verify it on the event the Klaviyo sender
 * judges. Remote switch `klaviyoSessionToken` (container config), off by
 * default; init() can never turn it on. A raw dl_kprofile_id keeps today's
 * one-shot behaviour. A dlk2 token is never kept past its own expiry.
 */
import { AttributionManager } from './attribution';
import { storage } from './storage';
import { dataEncryption } from './encryption';

// jsdom has no crypto.subtle or TextEncoder; the encrypted store needs both
// (same substitution as identity-pii.test.ts).
const nodeWebCrypto = require('crypto').webcrypto;
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: nodeWebCrypto, configurable: true, writable: true });
}
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  Object.assign(globalThis, { TextEncoder, TextDecoder });
}

const SIG = 'A'.repeat(43);
const DLK1 = `dlk1.PROFILE1.${SIG}`;
const dlk2 = (expS: number) => `dlk2.PROFILE1.${expS}.${SIG}`;
const nowS = () => Math.floor(Date.now() / 1000);

function setPage(search: string): void {
  window.history.replaceState({}, '', '/' + (search || ''));
}

async function landed(search: string, opts: { enabled?: boolean; marketing?: boolean } = {}): Promise<AttributionManager> {
  setPage(search);
  const attr = new AttributionManager({ marketingAllowed: () => opts.marketing !== false });
  attr.captureAttribution();
  await attr.hydrateKlaviyoProfileBinding();
  if (opts.enabled !== undefined) attr.setKlaviyoSessionTokenEnabled(opts.enabled);
  return attr;
}

async function flush(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Klaviyo session token (FX-126, remote switch klaviyoSessionToken)', () => {
  beforeAll(async () => { await dataEncryption.initialize('ws-test', 'anon_device_test'); });
  beforeEach(() => { try { localStorage.clear(); } catch { /* memory */ } setPage(''); });
  afterEach(async () => { await flush(); try { localStorage.clear(); } catch { /* memory */ } });

  test('off (default): nothing is kept beyond today\'s one-shot; no later event carries it', async () => {
    const attr = await landed(`?dl_kprofile_id=${DLK1}`);
    expect(attr.consumeKlaviyoProfileBinding()).toBe(DLK1);
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
    await flush();
    expect(storage.keys().some((k) => k.includes('klaviyo_session_token'))).toBe(false);
  });

  test('on: a signed token rides on each later view_item / add_to_cart / checkout_started of the session', async () => {
    const attr = await landed(`?dl_kprofile_id=${DLK1}`, { enabled: true });
    expect(attr.consumeKlaviyoProfileBinding()).toBe(DLK1); // the landing event, as today
    for (const name of ['view_item', 'add_to_cart', 'checkout_started']) {
      expect(attr.klaviyoSessionTokenFor(name, 's1')).toBe(DLK1);
    }
    expect(attr.klaviyoSessionTokenFor('pageview', 's1')).toBeNull();
    expect(attr.klaviyoSessionTokenFor('purchase', 's1')).toBeNull();
  });

  test('on: it survives a page load in the same session, and ends with the session', async () => {
    const first = await landed(`?dl_kprofile_id=${DLK1}`, { enabled: true });
    expect(first.klaviyoSessionTokenFor('view_item', 's1')).toBe(DLK1);
    await flush();
    const next = await landed('', { enabled: true });
    expect(next.klaviyoSessionTokenFor('add_to_cart', 's1')).toBe(DLK1);
    expect(next.klaviyoSessionTokenFor('add_to_cart', 's2')).toBeNull();
    await flush();
    const later = await landed('', { enabled: true });
    expect(later.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
  });

  test('a raw id is never kept for the session (today\'s one-shot only)', async () => {
    const attr = await landed('?dl_kprofile_id=PROFILE1', { enabled: true });
    expect(attr.consumeKlaviyoProfileBinding()).toBe('PROFILE1');
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
    for (const bad of ['dlk1.PROFILE1.short', `dlk1.PRO-FILE.${SIG}`, `dlk3.PROFILE1.${SIG}`, `dlk2.PROFILE1.x.${SIG}`]) {
      const other = await landed(`?dl_kprofile_id=${encodeURIComponent(bad)}`, { enabled: true });
      expect(other.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
    }
  });

  test('dlk2: kept until its own expiry, never after; an expired one is never kept', async () => {
    const exp = nowS() + 3600;
    const live = await landed(`?dl_kprofile_id=${dlk2(exp)}`, { enabled: true });
    expect(live.klaviyoSessionTokenFor('view_item', 's1')).toBe(dlk2(exp));
    expect(live.klaviyoSessionTokenFor('view_item', 's1', exp * 1000 + 1000)).toBeNull();
    const expired = await landed(`?dl_kprofile_id=${dlk2(nowS() - 1)}`, { enabled: true });
    expect(expired.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
  });

  test('marketing consent withdrawn: the token is dropped', async () => {
    let allowed = true;
    setPage(`?dl_kprofile_id=${DLK1}`);
    const attr = new AttributionManager({ marketingAllowed: () => allowed });
    attr.captureAttribution();
    await attr.hydrateKlaviyoProfileBinding();
    attr.setKlaviyoSessionTokenEnabled(true);
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBe(DLK1);
    allowed = false;
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
    allowed = true;
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
  });

  test('the switch arriving after landing (container config is late) still keeps the token; switched off clears it', async () => {
    const attr = await landed(`?dl_kprofile_id=${DLK1}`);
    attr.consumeKlaviyoProfileBinding();
    attr.setKlaviyoSessionTokenEnabled(true);
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBe(DLK1);
    attr.setKlaviyoSessionTokenEnabled(false);
    expect(attr.klaviyoSessionTokenFor('view_item', 's1')).toBeNull();
    await flush();
    expect(storage.keys().some((k) => k.includes('klaviyo_session_token'))).toBe(false);
  });
});
