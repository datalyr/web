/**
 * In-app browser -> real browser handoff.
 *
 * An ad tapped inside Instagram / Facebook / TikTok opens in the app's own webview,
 * whose cookie jar is separate from Safari/Chrome. When the person then taps the app's
 * "Open in Safari/Chrome", the real browser opens whatever URL is in the address bar and
 * starts as a brand-new visitor, so the ad click and the purchase never meet (88.5% of
 * click-bearing visitors arrive in an in-app browser, measured 2026-09-18).
 *
 * So while we run INSIDE an in-app browser we keep a short-lived token in the address
 * bar (`?_dl_h=<visitor>.<time>`), refreshed while the page is open. Whenever the person
 * opens the page in their real browser, the URL already carries it and that browser
 * continues as the same visitor. No banner, no prompt, nothing visible on the page.
 *
 * This is NOT the old raw `_dl_vid` (removed in FSR-50 because a shared link merged
 * unrelated people). What makes it safe:
 *   - it expires: both browsers are on the same device and clock, so a token older than
 *     IN_APP_HANDOFF_MAX_AGE_MS (2 minutes) is refused. A link pasted into a chat later does
 *     nothing;
 *   - a webview never forwards a token it did not write: an inbound `_dl_h` is stripped there
 *     whether or not the writer is allowed to run, so a stranger's token cannot ride along;
 *   - it is only adopted by a browser that has NO visitor yet (an existing identity
 *     always wins) and that is itself a real browser, not another webview;
 *   - the id must be one we minted (anon_<uuid>); anything else is ignored;
 *   - it is emitted only inside an in-app browser and only while tracking is allowed;
 *   - it is stripped from the address bar on arrival and never reaches a tracked URL.
 */

export const IN_APP_HANDOFF_PARAM = '_dl_h';
// The token is rewritten every 30s while the page is open, so it is at most ~30s old when
// the URL leaves the webview, and "Open in Safari" is near-instant. Two minutes covers a slow
// cold start; anything longer only widens the window in which a shared link could merge
// two people (the FSR-50 failure this design exists to avoid).
export const IN_APP_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;
export const IN_APP_HANDOFF_REFRESH_MS = 30 * 1000;
const IN_APP_HANDOFF_CLOCK_SKEW_MS = 60 * 1000;

// Same tokens as the server-side label (datalyr-v2 infra/cloudflare/lib/browser-context.js).
const IN_APP_BROWSER_RE = /Instagram|\bFBAN\/|\bFBAV\/|FB_IAB|FBIOS|\bFB4A\b|musical_ly|BytedanceWebview|\bTikTok\b|trill_|Snapchat|\[Pinterest\/|\bPinterest\/(?!0\.)|LinkedInApp|\bTwitter(?:Android|for iPhone)?\b|\bLine\/|MicroMessenger|\bBarcelona\b|\bGSA\/|\bReddit\/|;\s*wv\)/i;
// Link-preview renderers and crawlers carry the app's name but are not a person in a webview.
const NOT_A_VISITOR_RE = /bot\b|crawler|spider|preview|facebookexternalhit|\+https?:\/\//i;
const HANDOFF_VISITOR_ID_RE = /^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The apps that offer "Open in Safari/Chrome". The writer runs ONLY in these: a generic Android
// webview (a bank app, a news reader) has no such affordance, so a token there could only ever
// leave through a share sheet.
const HANDOFF_SOURCE_APP_RE = /Instagram|\bFBAN\/|\bFBAV\/|FB_IAB|FBIOS|\bFB4A\b|musical_ly|BytedanceWebview|\bTikTok\b|trill_|Snapchat|\[Pinterest\/|\bPinterest\/(?!0\.)|LinkedInApp|\bTwitter(?:Android|for iPhone)?\b|\bBarcelona\b|\bReddit\//i;

/** True inside an app whose in-app browser can hand the page to the real browser. */
export function isHandoffSourceApp(userAgent?: string): boolean {
  const source = userAgent !== undefined
    ? userAgent
    : (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const ua = String(source || '').slice(0, 512);
  return !!ua && !NOT_A_VISITOR_RE.test(ua) && HANDOFF_SOURCE_APP_RE.test(ua);
}

/** True inside ANY webview (broad on purpose: a webview must never adopt or forward a token). */
export function isInAppBrowser(userAgent?: string): boolean {
  const source = userAgent !== undefined
    ? userAgent
    : (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const ua = String(source || '').slice(0, 512);
  return !!ua && !NOT_A_VISITOR_RE.test(ua) && IN_APP_BROWSER_RE.test(ua);
}

/** `<visitor>.<base36 ms>`, or null when the id is not one we minted. */
export function encodeInAppHandoff(visitorId: string | null | undefined, now: number): string | null {
  return HANDOFF_VISITOR_ID_RE.test(visitorId || '')
    ? `${visitorId}.${Math.floor(now).toString(36)}`
    : null;
}

/** The visitor id when the token is one of ours and still fresh, else null. */
export function parseInAppHandoff(raw: unknown, now: number): string | null {
  if (typeof raw !== 'string' || raw.length > 96) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const visitorId = raw.slice(0, dot);
  const stamp = raw.slice(dot + 1);
  if (!HANDOFF_VISITOR_ID_RE.test(visitorId) || !/^[0-9a-z]{6,11}$/.test(stamp)) return null;
  const age = now - parseInt(stamp, 36);
  if (!Number.isFinite(age) || age > IN_APP_HANDOFF_MAX_AGE_MS || age < -IN_APP_HANDOFF_CLOCK_SKEW_MS) return null;
  return visitorId;
}
