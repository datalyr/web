# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **TR-22: landing attribution is captured eagerly, before the container fetch.** The first
  attribution read sat inside the initial `page()` — *after* `await container.init()` (a ~3s
  budget) — so a router / consent tool that strips `fbclid` via `history.replaceState` within
  that window, or a fast bounce, lost the click id entirely. `initializeAsync` now calls
  `getAttributionData()` at the very top (before any await), warming the query-param cache and
  persisting first/last touch immediately.
- **9.A.6: `gbraid`/`wbraid`/`rdt_cid`/`obclid`/`irclid`/`ko_click_id` now map to their real
  source** (google/google/reddit/outbrain/impact/klaviyo) in `determineSource` instead of the
  generic `paid` fallback.
- **TR-13: terminal unload no longer beacons the already-persisted offline backlog (duplicate
  purchases).** `forceFlush(terminal)` beaconed `live + offlineQueue` and persisted the same
  set; the backlog then re-drained on the next page load, so a purchase parked during an outage
  was delivered at tab-close AND re-drained later — and when those land >6h apart, ingest's
  dedup window has expired → a duplicate purchase row + double conversion. It now beacons ONLY
  the live queue (created this session; its beacon + next-load drain both land <6h, so dedup
  absorbs them) while still persisting the whole backlog for the next-load drain to deliver
  exactly once. FSR-15 persist-first semantics unchanged.
- **TR-03: marketing-declined visitors no longer have Meta/Google ad signals captured,
  cookie-written, or shipped.** `consentAllowsMarketing()` gated only container init / cart
  attrs / auto-identify — never the event path — so a granular "analytics yes, marketing no"
  shopper still had `fbclid`/`gclid`/`_fbp`/`_fbc` on every event and `captureAdCookies()`
  actively **synthesized and wrote** `_fbp`/`_fbc` cookies, which the server then forwarded to
  Meta/Google CAPI. `AttributionManager` now takes a live `marketingAllowed` predicate: when
  it's false it (a) skips `_fbp`/`_fbc`/gclid-time synthesis (no cookie writes) and (b) strips
  click-IDs + ad cookies from `getAttributionData()`'s payload, keeping analytics-scoped
  `utm_*` / source / medium / campaign / first-last-touch / `_ga` / `_gid`. The predicate is
  re-evaluated per event, so a later grant restores capture with no reload. Default (no consent
  signal) is unchanged — signals are stripped only on an explicit decline.
- **TR-15: Shopify Customer Privacy consent is enforced during its async load + at drain time.**
  `customerPrivacy` loads asynchronously, so the pre-load window failed open (events sent) and
  the offline drain ran on a fail-open latched flag — a returning *declined* visitor fires no
  `visitorConsentCollected` event, so their persisted backlog drained before the decline was
  known. The SDK now (a) calls `Shopify.loadFeatures([{name:'consent-tracking-api'}])` at init
  and re-evaluates consent in the callback (gate + purge as soon as the API answers), (b)
  re-checks consent *inside* the offline-drain loop via a live predicate (declined → purge the
  backlog instead of sending), and (c) persists the in-memory anon id on a mid-session grant
  (opt-in / consent) so that session's events don't land under a visitor_id that vanishes on
  the next page load.
- **TR-14: `setConsent({analytics:false})` now fully tears down auto-identify + purges PII.**
  On analytics withdrawal `setConsent` gated the queue and container but — unlike `optOut()`
  — left `autoIdentify` alive: its form/fetch interceptors and `/account.json` polling kept
  running, and `triggerIdentify` persisted the captured email to storage **after** withdrawal
  (PII newly written at rest → a GDPR/consent-audit failure on non-Shopify CMP installs). It
  now mirrors `optOut()`: destroys `autoIdentify` and purges `dl_user_traits` /
  `dl_auto_identified_email` / `dl_journey` (auto-identify resumes on the next load if consent
  is re-granted).
- **TR-04: URL fragment tokens are now redacted.** `redactUrl` only rewrote the query
  string and returned early when there was no `?`, reattaching the fragment verbatim — so
  OAuth-implicit / Supabase magic-link sessions (`/welcome#access_token=eyJ…`), which carry
  the JWT in the **fragment** with no query string at all, shipped the full token in `url` /
  pageview `url` / `landingPage` (persisted in `dl_first_touch` for 90 days and attached to
  every event, onward to ad platforms). It now applies the same secret/PII denylist to a
  `k=v&` fragment — both the implicit-flow shape (`#access_token=…&refresh_token=…`) and a
  SPA hash-route with its own query (`#/reset?access_token=…`). Non-k=v fragments
  (`#section`, `#/route`) are left byte-identical.

## [1.7.4] - 2026-06-11

### Added — Stripe Payment Link auto-decoration (D1, default ON)
- **`<a href>` links to `buy.stripe.com`** (exact-host match via the URL API — never
  substring, never `checkout.stripe.com`) are automatically stamped with
  `client_reference_id=<visitor_id>` (only if absent; merchant-set wins; visitor id must
  pass Stripe's `/^[A-Za-z0-9_-]{1,200}$/` format or we skip silently) and, for identified
  users in standard privacy mode, `prefilled_email` (only if both `prefilled_email` and
  `locked_prefilled_email` are absent). A decorated link's `checkout.session.completed`
  webhook is deterministically attributed with zero merchant/server work.
- **`<stripe-pricing-table>` / `<stripe-buy-button>` embeds** get the
  `client-reference-id` attribute when absent.
- New config: `stripePaymentLinks?: boolean` (default ON; set `false` to opt out) and
  `stripeLinkDomains?: string[]` (extra exact hostnames for merchant custom payment-link
  domains). Script-tag installs: `data-stripe-payment-links="false"`,
  `data-stripe-link-domains="pay.example.com"`.
- Mirrors the CheckoutChamp outbound-link sync: stamp on init, debounced (150ms)
  MutationObserver for SPA-rendered links, capture-phase click re-stamp + queue flush,
  disposer wired into `destroy()`/`pagehide`. Gated on `shouldTrack()` — opted-out /
  DNT / GPC visitors never get an id stamped into outbound links.

## [1.7.3] - 2026-06-10

Fixes from the 2026-06-10 full-stack review (Web SDK section). FSR ids reference
`docs-v2/FULL_STACK_REVIEW_2026-06-10.md`.

### Fixed — attribution (HIGH)
- **UTM attribution restored (FSR-13).** `captureAttribution()` stripped the `utm_`
  prefix, so events carried `source`/`campaign` while ingest and every attribution
  MV/lookup pipe key on `utm_source`/`utm_campaign` — the UTM leg of web attribution was
  dead. We now emit BOTH the canonical `utm_*` keys (what the server reads) and the
  stripped aliases (dashboards / `determineSource`). (`src/attribution.ts`)
- **Stale `_fbc` for repeat ad clicks (FSR-14).** A new `fbclid` over an existing 90-day
  `_fbc` never refreshed it, so Meta received the old campaign's click id / creation time.
  We now detect a new click (compare the URL `fbclid` to the one embedded in `_fbc`) and
  regenerate `_fbc` with the new id + current time. (`src/attribution.ts`)

### Fixed — delivery / reliability (HIGH)
- **Tab-switch no longer destroys the offline backlog (FSR-15).** `forceFlush` on every
  `visibilitychange` beacon-drained the persisted offline queue and erased it on
  beacon-enqueue (not delivery), losing the backlog during an outage. Now: tab switches
  use response-checked fetch drains; only terminal unload beacons, and it never erases the
  persisted copy on a mere `sendBeacon`=true (next-load drain clears it, dedup-safe). It
  also honors the 429 backoff window. (`src/queue.ts`, `src/index.ts`)
- **Critical events survive an unload mid-retry (FSR-16).** Purchase/signup/lead events
  lived only in the in-memory retry closure during backoff. They're now persisted to the
  offline queue before the first send and removed on confirmed delivery. (`src/queue.ts`)

### Fixed — identity (HIGH)
- **`user_id` no longer corrupted on reload (FSR-17).** Identifiers are read via a new
  `storage.getString()` that skips `JSON.parse`, so numeric ids don't change type and
  16+-digit snowflake ids aren't precision-truncated. (`src/storage.ts`, `src/identity.ts`)

### Fixed — MEDIUM
- ccTLD same-site referrer classification now uses a real eTLD+1 helper (FSR-47).
- Internal-nav attribution fallback uses the fresher last-touch, not stale first-touch (FSR-48).
- Auto-identify form capture skips gift/recipient/refer-a-friend email fields (FSR-49).
- `_dl_vid` cross-domain bridge param is validated (`anon_<uuid>`), stripped from the URL,
  and never overwrites an existing visitor id — closing an identity-takeover footgun (FSR-50).
- `setConsent()` is safe before `init()` (FSR-51).
- `/container-scripts` fetch is time-boxed (3s) so it can't block the initial pageview (FSR-52).
- `identify()` no longer rotates the session id mid-session (FSR-53).
- Oversized batches drop `keepalive` so the 64KB cap can't permanently wedge the queue (FSR-54).
- Permanent 4xx batches are dropped instead of head-of-line-blocking the offline queue forever (FSR-55).
- `CookieStorage.get()` handles duplicate cookie names (returns the first) (FSR-56).
- `sanitizeEventData` key/value redaction anchored — stops dropping `author`/`session_*` and
  redacting `referrer_host`/semver/hex order ids/`$alias` user ids (FSR-57).

### Fixed — LOW
- CC purchase-pixel guard set only after the Meta pixel is confirmed live (FSR-102).
- `sdk_version` synced to package.json + a build-time guard (`build:check`) enforces it (FSR-103, FSR-46).
- Cross-domain CC bridge forwards both `gclid` and `fbclid` when present (FSR-104).
- Caller-passed event properties take precedence over auto-captured attribution/context (FSR-105).
- `reset()` clears first/last-touch attribution (cross-user contamination) (FSR-106).
- Visitor id is not persisted at init for opted-out / GPC / DNT visitors (FSR-107).
- Auto-identify form `MutationObserver` is disconnected on `destroy()`/opt-out (FSR-101).

### Build
- `scripts/check-bundle.js` (`npm run build:check`) fails the build unless the output
  bundles contain the `data-workspace-id` bootstrap + a current feature literal and the
  `sdk_version` matches package.json — guarding the 2026-05-26 outage mode (FSR-46).

## [1.7.1] - 2026-06-02

### Fixed (reliability — silent data loss)
- **Persisted offline queue is now drained on page load and on every periodic
  flush**, not only on a `window 'online'` transition. A visitor returning
  already-online never fired that event, so events that failed in a prior session
  (including revenue conversions) sat in `localStorage` until they aged out and were
  sliced away. They now retry as soon as the SDK initializes / on the next flush
  tick. (`src/queue.ts`)
- **Failed critical events (purchase/signup/lead) now have a retry path while
  online.** A transient 5xx parked them in the offline queue, which — per the bug
  above — only drained on an `online` transition that may never come. The periodic
  offline drain gives them a guaranteed retry. (`src/queue.ts`)
- **`forceFlush()` (page unload) no longer loses or double-sends events.** It now
  (a) includes the offline queue, not just the live queue; (b) chunks the payload
  under `sendBeacon`'s ~64KB cap (true byte length) instead of silently failing on
  large batches; (c) persists any refused chunk to storage so it survives to the next
  page load; (d) **excludes the batch already in-flight in `_flush`** (its keepalive
  fetch already carries it, so re-beaconing would double-send); and (e) **detaches
  what it sends synchronously**, so the multiple unload events the handler is wired to
  (`visibilitychange`/`pagehide`/`beforeunload`) can't re-beacon the same events.
  (`src/queue.ts`)
- **Transient send failures no longer double-send.** On a failed flush the events
  are moved to the offline queue *and removed from the live queue* (single owner),
  instead of living in both and relying on server-side dedup. (`src/queue.ts`)
- **Regression tests** for the queue's data-loss / double-send paths
  (`src/queue.test.ts`) — the file previously had zero coverage.

### Fixed (attribution correctness — from the deep web-SDK review)
- **Last-touch attribution is no longer overwritten with `direct`/`none` on internal
  navigations** — including same-site full-page navigation on classic multi-page stores.
  `determineSource()`/`determineMedium()` floor to `direct`/`none`, which made the "has
  attribution" check always true — so the persistent-attribution fallback was dead code
  and `storeLastTouch` overwrote a real paid last-touch on the next pageview. Now first/last
  touch are only (re)written when the pageview carries a real signal (click ID, UTM/campaign,
  or a referrer-derived source), and a **same-root-domain referrer is treated as `direct`**
  (not `referral`) so internal page-to-page navigation can't clobber the real source.
  (`src/attribution.ts`)
- **Multiple click IDs on one URL are all captured.** A URL carrying both `fbclid` and
  `gclid` (redirect chains / forwarded links) previously kept only the first; each
  present click ID is now also emitted as its own named field. (`src/attribution.ts`)
- **Synthetic `_fbp` uses a Meta-conformant decimal segment** (`fb.1.<ms>.<int>`) instead
  of a base36 string Meta ignores — improves EMQ on the CAPI-only path. (`src/attribution.ts`)
- **`sdk_version` now reports `1.7.1`** instead of the stale hardcoded `1.6.5`, so ingested
  data reflects which clients have these fixes. (`src/index.ts`)

### Fixed (consent / privacy — from the deep web-SDK review)
- **`optOut()` now actually stops tracking and clears PII.** Previously it set a flag and
  cleared only the in-memory live queue — events persisted *before* opt-out still drained
  on the next periodic/on-load tick (the queue had no consent gate), and stored PII was
  left at rest. Now opt-out disables the queue (no send, **and no re-persist** — the
  failure-path `moveToOfflineQueue`/`saveOfflineQueue` are gated too), purges the live +
  offline queues, tears down auto-identify, stops forwarding to third-party pixels, and
  removes `dl_user_traits` / `dl_auto_identified_email` / `dl_journey`. (Already-injected
  pixel globals like `fbq`/`gtag` persist in the page until reload — we stop feeding them
  but cannot fully unload a third-party script mid-session.) (`src/index.ts`, `src/queue.ts`)
- **`setConsent()` is now enforced, not just stored.** Gated by the full policy (analytics
  consent + opt-out + DNT/GPC): `analytics: false` disables first-party sending **and
  purges buffered events** (so they can't drain if consent is later re-granted);
  `marketing: false` / `sale: false` (CCPA "do not sell") stops forwarding to the
  third-party pixels and prevents them initializing on the next page load. Previously
  `dl_consent` was written and never read. (`src/index.ts`)
- **`syncOutboundLinkParams` (CC bridge) is gated on consent** — an opted-out / DNT / GPC
  visitor's id + click-ids are no longer stamped on outbound links. (`src/index.ts`)
- **`group()` / `alias()` honor consent** before mutating persisted identity, and `alias('')`
  is rejected. (`src/index.ts`)
- **`reset()` clears the auto-identified email, super-properties, and the journey** — fixes
  cross-user contamination on shared devices (the next user was never re-captured, and the
  prior user's email / super-props / touchpoints leaked into their events). (`src/index.ts`)

### Added (multi-touch journey — from the deep review)
- **Customer-journey touchpoints are now recorded** (one per session) so `touchpoint_count`
  and `days_since_first_touch` are real signals. `addTouchpoint()` previously had no
  callers, so the journey was always empty. (`src/index.ts`, `src/attribution.ts`)

### Fixed (pixel + lifecycle — from the deep review)
- **TikTok standard conversions are no longer mis-categorized.** The TikTok event map was
  keyed on Meta-style names (`'Purchase'`) but looked up with the raw event (`'purchase'`),
  so every standard event fell through and fired as a literal custom event. Now keyed on
  the raw lowercased name (with a workspace rule map first), with the full TikTok vocabulary
  (`purchase`→`CompletePayment`, etc.). (`src/container.ts`)
- **`session_id` is consistent again.** It changes on `identify()` (session rotation) and on
  timeout, but the identity manager only synced it at init — so the top-level `session_id`
  (from identity) disagreed with `event_data.session_id` (from session metrics). Now synced
  per event. (`src/index.ts`)
- **`destroy()` no longer leaks or wedges re-init.** It now removes the unload/visibility
  listeners and tears down the CC outbound-link observer, and resets the init promise +
  container/auto-identify so a `destroy()`+`init()` cycle comes back fully initialized.
  (`src/index.ts`)
- **SPA `pageview` no longer double-fires** on routers that `replaceState` on mount —
  consecutive same-URL navigations are deduped. (`src/index.ts`)
- **`trackAppDownloadClick()` awaits the flush** before navigating away, so the click event
  isn't lost on browsers without `sendBeacon`. (`src/index.ts`)
- **`setAttribution()` actually affects events now** (routes through the AttributionManager's
  last/first touch instead of a dead session key it only wrote and never read). (`src/index.ts`)

### Fixed (reliability — config / rate-limit / non-HTTPS)
- **Config is validated, not coerced.** Numeric options (`batchSize`/`flushInterval`/
  `maxRetries`/`retryDelay`/`maxOfflineQueueSize`) are clamped to sane ranges instead of
  `config.X || default` — which both silently turned a legitimate `0` into the default AND
  let a **negative `batchSize`** through, where `splice(0,-1)` looped forever and **froze
  the host tab**. (`src/queue.ts`)
- **429 no longer causes a retry-storm.** A `429` now honors `Retry-After` as a single
  backoff window — the batch parks in the offline queue and flush/drain are gated until the
  window passes. Previously a 429 *both* scheduled a flush *and* fell into exponential-
  backoff retry, firing ~6 requests inside the window the server asked us to wait,
  amplifying an ingest overload. (`src/queue.ts`)
- **Non-secure (`http://`) pages still track.** Encryption init is isolated so a missing
  `crypto.subtle` (http:// or old browser) no longer aborts the rest of init — SPA tracking,
  container/pixels, and the initial pageview still run; only PII-at-rest encryption is
  skipped. (`src/index.ts`)

### Fixed (privacy)
- **Third-party pixels are no longer loaded for opted-out / DNT / GPC / strict
  visitors.** Container initialization (which injects Meta/Google/TikTok loaders and
  calls `fbq('init', …, advancedMatching)` with the visitor's hashed email) is now
  gated on `shouldTrack()` and an explicit `privacyMode: 'strict'`, matching the
  existing auto-identify gate. (`src/index.ts`)
- **Auto-identified email is stored encrypted (AES-GCM) instead of plaintext
  `localStorage`**, consistent with `dl_user_traits`. A value written by a pre-1.7.1
  build is plaintext; it is detected (raw read — ciphertext is base64, so an `@` means
  it was never encrypted) and **re-encrypted in place on next init**, so the installed
  base is migrated, not just new visitors. (`src/auto-identify.ts`)

## [1.7.0] - 2026-06-01

### Added
- **Auto Identity Bridge — remote SDK config.** The `/container-scripts` response
  now carries a `config` envelope (the workspace's dashboard settings), so the
  following can be controlled from Settings → Identity & Attribution with **no
  snippet changes**: `autoIdentify`, `autoIdentifyForms`, `autoIdentifyAPI`,
  `autoIdentifyShopify`, `shopifyCartAttributes`, `checkoutChampDomains`,
  `respectGlobalPrivacyControl`, `respectDoNotTrack`, `privacyMode`.
  - Merge precedence per key: **built-in defaults ← remote (dashboard) ← explicit `init()`**.
    Explicit code always wins; the dashboard overrides built-in defaults for any
    key the caller didn't set explicitly (`applyRemoteConfig` in `src/config.ts`).
- **Shopify cart attribution** (`shopifyCartAttributes`) — stamps the visitor ID
  and Meta click IDs (`_fbc`/`_fbp`/`_fbclid`) into the Shopify cart so server-side
  order webhooks attribute guest checkouts to the ad, with no browser pixel.

### Changed
- `autoIdentifyAPI` (capture email from API responses) now defaults **off**; opt in
  explicitly or via the dashboard.
- Strict `privacyMode` forces `autoIdentify` off regardless of other settings.

### Notes
- `platform` is intentionally NOT remote-configurable — it's an install-time
  snippet attribute (`data-platform`), because CheckoutChamp behaviors run before
  the remote config arrives.
- A missing/older worker (no `config` envelope) is a no-op: built-in defaults stand.

## [1.2.1] - 2025-01

### Changed
- Complete README rewrite to match iOS/React Native SDK documentation style
- Fixed script tag URL from container.js to dl.js

## [1.2.0] - 2025-01

### Changed
- Updated SDK version identifier
- Cleaned up README documentation

### Fixed
- All critical issues from security audit have been addressed:
  - Attribution type checking now correctly validates source/medium/clickId/campaign
  - Session timeout defaults to 60 minutes (matching documentation)
  - All public methods properly check initialization state
  - Encryption initialization race condition prevented with initializationPromise
  - Session fixation prevented with rotateSessionId() on identify
  - Concurrent flush race conditions prevented with mutex locks

## [1.1.1] - 2025-01

### Added
- Session fixation protection (session ID rotation on identify)
- Concurrent flush mutex locks
- Encryption initialization promise pattern
- Auto-identify manager for forms and API responses

### Changed
- Increased attribution window from 30 to 90 days (for B2B sales cycles)
- Increased session timeout from 30 to 60 minutes (for OAuth flows)

### Fixed
- Query params cache now cleared on SPA navigation
- Offline queue retry with exponential backoff
- Critical events properly bypass batching
- PII encryption with AES-GCM

## [1.1.0] - 2025-01

### Added
- Container script manager for third-party pixels
- Plugin system for extensibility
- Privacy modes (standard/strict)
- Global Privacy Control (GPC) support
- Cross-subdomain tracking with auto cookie domain
- SPA route tracking with history API interception
- Performance metrics collection
- First/last touch attribution with 90-day window
- Customer journey tracking (up to 30 touchpoints)

### Changed
- Improved batching with critical/high-priority event detection
- Enhanced offline queue with persistence

## [1.0.0] - 2024-12

### Added
- Initial release
- Event tracking (track, page, screen, identify, group, alias)
- Automatic attribution capture (UTM, click IDs, referrer)
- Session management with configurable timeout
- Offline event queue with retry
- User consent management (optOut, optIn, setConsent)
- TypeScript support with full type definitions
- GDPR/CCPA compliance features
