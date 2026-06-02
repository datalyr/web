# Changelog

All notable changes to this project will be documented in this file.

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
