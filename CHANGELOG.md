# Changelog

All notable changes to this project will be documented in this file.

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
