/**
 * In-app browser -> real browser handoff. The old raw `_dl_vid` bridge was an
 * identity-takeover hole (FSR-50, identity.test.ts); these tests pin what makes
 * `_dl_h` different: it expires, only our own ids are accepted, an existing
 * identity always wins, and a webview never adopts.
 */
import { IdentityManager } from './identity';
import {
  IN_APP_HANDOFF_MAX_AGE_MS, IN_APP_HANDOFF_PARAM,
  encodeInAppHandoff, isHandoffSourceApp, isInAppBrowser, parseInAppHandoff,
} from './in-app-handoff';
import { redactUrl } from './utils';

const VISITOR = 'anon_6095132b-3627-41b5-81a4-df0186de375f';
const NOW = Date.parse('2026-09-18T22:00:00Z');
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const SAFARI = `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`;
const INSTAGRAM = `${IOS} Mobile/15E148 Instagram 339.0.3.12.91`;

function setUrl(search: string) { window.history.replaceState({}, '', '/' + search); }
function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}
function clearIdentity() {
  document.cookie.split(';').forEach(c => {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  localStorage.clear();
}

describe('in-app handoff token', () => {
  test('a fresh token round-trips; an expired or future-dated one is refused', () => {
    const token = encodeInAppHandoff(VISITOR, NOW)!;
    expect(parseInAppHandoff(token, NOW + 5_000)).toBe(VISITOR);
    expect(parseInAppHandoff(token, NOW + IN_APP_HANDOFF_MAX_AGE_MS - 1)).toBe(VISITOR);
    // a link pasted into a chat and opened later does nothing
    expect(parseInAppHandoff(token, NOW + IN_APP_HANDOFF_MAX_AGE_MS + 1)).toBeNull();
    expect(parseInAppHandoff(token, NOW + 24 * 3600_000)).toBeNull();
    expect(parseInAppHandoff(encodeInAppHandoff(VISITOR, NOW + 3600_000), NOW)).toBeNull();
  });

  test('only ids we minted are ever encoded or adopted', () => {
    for (const id of ['user_123', 'anon_not-a-uuid', '', null, `${VISITOR}|x`, 'shopify_123']) {
      expect(encodeInAppHandoff(id as string, NOW)).toBeNull();
    }
    const stamp = Math.floor(NOW).toString(36);
    for (const raw of [`attacker.${stamp}`, `user_1.${stamp}`, `${VISITOR}.`, `${VISITOR}.zz`, VISITOR, `.${stamp}`, 'x'.repeat(200), null, undefined, 42]) {
      expect(parseInAppHandoff(raw, NOW)).toBeNull();
    }
  });

  test('detects the ad-platform webviews, not real browsers or crawlers', () => {
    expect(isInAppBrowser(INSTAGRAM)).toBe(true);
    expect(isInAppBrowser(`${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.35.107]`)).toBe(true);
    expect(isInAppBrowser(`${IOS} Mobile/15E148 musical_ly_35.1.0 BytedanceWebview/d8a21c6`)).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36')).toBe(true);
    expect(isInAppBrowser(SAFARI)).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 (compatible; Instagram-crawler/1.0)')).toBe(false);
    expect(isInAppBrowser('')).toBe(false);
  });

  test('the window is two minutes, and only apps that offer "Open in browser" ever write a token', () => {
    expect(IN_APP_HANDOFF_MAX_AGE_MS).toBe(2 * 60 * 1000);
    expect(isHandoffSourceApp(INSTAGRAM)).toBe(true);
    const genericWebview = 'Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
    expect(isInAppBrowser(genericWebview)).toBe(true);      // never adopts / forwards
    expect(isHandoffSourceApp(genericWebview)).toBe(false); // but never writes either
    expect(isHandoffSourceApp(SAFARI)).toBe(false);
  });

  test('the token never reaches a tracked URL', () => {
    const token = encodeInAppHandoff(VISITOR, NOW)!;
    const out = redactUrl(`https://shop.example/p?gclid=abc&${IN_APP_HANDOFF_PARAM}=${token}&utm_source=ig`);
    expect(out).not.toContain(IN_APP_HANDOFF_PARAM);
    expect(out).not.toContain(VISITOR);
    expect(out).toContain('gclid=abc');
    expect(out).toContain('utm_source=ig');
  });
});

describe('IdentityManager — _dl_h adoption', () => {
  const realUa = window.navigator.userAgent;
  beforeEach(() => { clearIdentity(); setUserAgent(SAFARI); });
  afterEach(() => { setUserAgent(realUa); setUrl(''); });

  test('a real browser with no visitor continues the in-app visitor, and the token is stripped', () => {
    setUrl(`?${IN_APP_HANDOFF_PARAM}=${encodeInAppHandoff(VISITOR, Date.now())}&keep=1`);
    const identity = new IdentityManager();
    expect(identity.getAnonymousId()).toBe(VISITOR);
    expect(identity.adoptedFromInAppHandoff).toBe(true);
    expect(window.location.search).not.toContain(IN_APP_HANDOFF_PARAM);
    expect(window.location.search).toContain('keep=1');
    // and it persisted, so the next page load keeps it without any token
    expect(new IdentityManager().getAnonymousId()).toBe(VISITOR);
  });

  test('an existing visitor is never overwritten (shared link into a browser that has history)', () => {
    const existing = new IdentityManager().getAnonymousId();
    setUrl(`?${IN_APP_HANDOFF_PARAM}=${encodeInAppHandoff(VISITOR, Date.now())}`);
    const identity = new IdentityManager();
    expect(identity.getAnonymousId()).toBe(existing);
    expect(identity.adoptedFromInAppHandoff).toBe(false);
    expect(window.location.search).not.toContain(IN_APP_HANDOFF_PARAM); // still stripped
  });

  test('a stale token (link shared later) mints a fresh visitor and is stripped', () => {
    setUrl(`?${IN_APP_HANDOFF_PARAM}=${encodeInAppHandoff(VISITOR, Date.now() - IN_APP_HANDOFF_MAX_AGE_MS - 1000)}`);
    const identity = new IdentityManager();
    expect(identity.getAnonymousId()).not.toBe(VISITOR);
    expect(identity.getAnonymousId()).toMatch(/^anon_/);
    expect(window.location.search).not.toContain(IN_APP_HANDOFF_PARAM);
  });

  test('a forged token with an id we never minted is ignored', () => {
    setUrl(`?${IN_APP_HANDOFF_PARAM}=victim_user.${Date.now().toString(36)}`);
    expect(new IdentityManager().getAnonymousId()).toMatch(/^anon_/);
  });

  test('a webview never adopts AND never forwards a token it did not write', () => {
    // A shares a link; B opens it inside Instagram where the writer cannot run (consent
    // unresolved / feature off). If A's token stayed in B's address bar, B's "Open in
    // Safari" would make Safari adopt A — the FSR-50 merge by the side door.
    setUserAgent(INSTAGRAM);
    setUrl(`?${IN_APP_HANDOFF_PARAM}=${encodeInAppHandoff(VISITOR, Date.now())}&keep=1`);
    const identity = new IdentityManager({ persistNewId: false });
    expect(identity.getAnonymousId()).not.toBe(VISITOR);
    expect(window.location.search).not.toContain(IN_APP_HANDOFF_PARAM);
    expect(window.location.search).toContain('keep=1');
  });

  test('an opted-out / GPC visitor never adopts, so a later consent grant cannot persist a stranger', () => {
    setUrl(`?${IN_APP_HANDOFF_PARAM}=${encodeInAppHandoff(VISITOR, Date.now())}`);
    const identity = new IdentityManager({ persistNewId: false });
    expect(identity.getAnonymousId()).not.toBe(VISITOR);
    expect(identity.adoptedFromInAppHandoff).toBe(false);
    identity.enablePersistence();
    expect(new IdentityManager().getAnonymousId()).not.toBe(VISITOR);
    expect(window.location.search).not.toContain(IN_APP_HANDOFF_PARAM);
  });
});
