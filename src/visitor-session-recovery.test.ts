/**
 * Visitor id recovery from the stored session record.
 *
 * Meta's in-app browsers reload the ad landing page mid-session with our
 * session record intact but both the __dl_visitor_id cookie and
 * dl_anonymous_id gone (Instagram ~2%, Facebook ~1% of sessions, measured
 * 2026-10-08). A fresh id split one visit into two visitors, so a pixcene
 * buyer's Stripe purchase landed on a visitor with none of the funnel steps.
 */

import { IdentityManager } from './identity';
import { SessionManager } from './session';
import { storage, cookies } from './storage';

type DatalyrSdkModule = typeof import('./index');

const VISITOR = 'anon_7f06838a-22a9-4aa3-a98e-bf5891412c6e';

function clearAll(): void {
  try { localStorage.clear(); } catch { /* memory fallback */ }
  cookies.remove('__dl_visitor_id');
}

/** What the Meta in-app browser leaves behind: everything but the visitor id. */
function loseVisitorId(): void {
  cookies.remove('__dl_visitor_id');
  storage.remove('dl_anonymous_id');
}

function storedRecord(): Record<string, unknown> | null {
  return storage.get('dl_session_data');
}

function loadSdk(): DatalyrSdkModule {
  let sdk!: DatalyrSdkModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require('./index') as DatalyrSdkModule;
  });
  return sdk;
}

async function makeSdk() {
  const instance = loadSdk().createDatalyrInstance();
  instance.init({
    workspaceId: 'ws-visitor-recovery',
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

/** Event payloads as they reach the queue. */
function captureQueued(instance: any): any[] {
  const seen: any[] = [];
  jest.spyOn(instance.queue, 'enqueue').mockImplementation((payload: any) => { seen.push(payload); });
  return seen;
}

describe('session record carries the visitor id', () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  test('the stored record is stamped with the current visitor id', () => {
    const identity = new IdentityManager();
    const session = new SessionManager();
    session.setVisitorIdProvider(() => identity.getPersistableAnonymousId());
    expect(storedRecord()?.visitorId).toBe(identity.getAnonymousId());
    expect(storedRecord()?.id).toBe(session.getSessionId());
    session.destroy();
  });

  test('no visitor id is written while ids must stay in memory (FSR-107)', () => {
    const identity = new IdentityManager({ persistNewId: false });
    const session = new SessionManager();
    session.setVisitorIdProvider(() => identity.getPersistableAnonymousId());
    expect(storedRecord()).not.toBeNull();
    expect(storedRecord()?.visitorId).toBeUndefined();
    session.destroy();
  });
});

describe('IdentityManager recovers a lost visitor id from the session record', () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  test('cookie and dl_anonymous_id gone, record kept: the same visitor comes back and is re-persisted', () => {
    storage.set('dl_session_data', { id: 'sess_x', isActive: true, visitorId: VISITOR });
    const identity = new IdentityManager();
    expect(identity.getAnonymousId()).toBe(VISITOR);
    expect(identity.recoveredFromSession).toBe(true);
    expect(storage.getString('dl_anonymous_id')).toBe(VISITOR);
    expect(cookies.get('__dl_visitor_id')).toBe(VISITOR);
  });

  test('a persisted visitor id still wins over the record', () => {
    const existing = 'anon_11111111-1111-4111-8111-111111111111';
    storage.set('dl_anonymous_id', existing);
    storage.set('dl_session_data', { id: 'sess_x', isActive: true, visitorId: VISITOR });
    const identity = new IdentityManager();
    expect(identity.getAnonymousId()).toBe(existing);
    expect(identity.recoveredFromSession).toBe(false);
  });

  test('a record without a well-formed visitor id mints a fresh one', () => {
    for (const visitorId of [undefined, 'not-an-id', 'anon_' + 'A'.repeat(500), 42]) {
      clearAll();
      storage.set('dl_session_data', { id: 'sess_x', isActive: true, visitorId });
      const identity = new IdentityManager();
      expect(identity.getAnonymousId()).toMatch(/^anon_[0-9a-f-]{36}$/i);
      expect(identity.getAnonymousId()).not.toBe(visitorId);
      expect(identity.recoveredFromSession).toBe(false);
    }
  });

  test('no record at all mints a fresh one', () => {
    const identity = new IdentityManager();
    expect(identity.getAnonymousId()).toMatch(/^anon_/);
    expect(identity.recoveredFromSession).toBe(false);
  });
});

describe('end to end through the SDK', () => {
  beforeEach(() => {
    clearAll();
    delete (window as any).datalyr;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete (window as any).datalyr;
    jest.restoreAllMocks();
    clearAll();
  });

  test('a reload that lost the visitor id keeps the visitor and the session, and marks the first event', async () => {
    const first = await makeSdk();
    const visitor = first.getAnonymousId();
    const sessionId = first.getSessionId();
    first.track('add_to_cart');

    loseVisitorId();

    const reloaded = await makeSdk();
    const queued = captureQueued(reloaded);
    reloaded.track('begin_checkout');
    reloaded.track('pageview');

    expect(reloaded.getAnonymousId()).toBe(visitor);
    expect(reloaded.getSessionId()).toBe(sessionId);
    expect(queued[0].event_data.visitor_recovered).toBe('session');
    expect(queued[1].event_data.visitor_recovered).toBeUndefined();
  });

  test('reset() starts a new session whose record carries the new visitor, so recovery never resurrects the old one', async () => {
    const sdk = await makeSdk();
    const before = sdk.getAnonymousId();
    sdk.reset();
    const after = sdk.getAnonymousId();
    expect(after).not.toBe(before);
    expect(storedRecord()?.visitorId).toBe(after);

    loseVisitorId();
    const reloaded = await makeSdk();
    expect(reloaded.getAnonymousId()).toBe(after);
  });
});
