# Changelog

All notable changes to this project will be documented in this file.

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
