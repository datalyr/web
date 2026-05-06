# @datalyr/web

Browser SDK for event tracking, user identity, and attribution. Version 1.4.1.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [API Reference](#api-reference)
  - [Event Tracking](#event-tracking)
  - [User Identity](#user-identity)
  - [Session](#session)
  - [Attribution](#attribution)
  - [Super Properties](#super-properties)
  - [Privacy and Consent](#privacy-and-consent)
  - [Queue and Network](#queue-and-network)
  - [Container Scripts](#container-scripts)
  - [Debugging](#debugging)
  - [Lifecycle](#lifecycle)
- [Web-to-App Attribution](#web-to-app-attribution)
- [SPA Support](#spa-support)
- [Framework Integration](#framework-integration)
- [TypeScript](#typescript)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

### NPM

```bash
npm install @datalyr/web
```

### Script Tag

```html
<script defer src="https://track.datalyr.com/dl.js"
        data-workspace-id="YOUR_WORKSPACE_ID"></script>
```

The script tag loads externally (zero bundle size) and auto-initializes. Access the SDK via `window.datalyr`.

Choose one installation method. Using both causes conflicts.

| Feature | Script Tag | NPM |
|---------|-----------|-----|
| Bundle Size | 0 (external) | ~15KB |
| TypeScript | No | Yes |
| Access | `window.datalyr` | `import datalyr` |
| Initialize | Automatic | `datalyr.init()` |

---

## Quick Start

```javascript
import datalyr from '@datalyr/web';

datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

// Wait for async initialization (encryption, container, initial page view)
await datalyr.ready();

// Track events
datalyr.track('button_clicked', { button: 'signup' });

// Identify users
datalyr.identify('user_123', { email: 'user@example.com' });

// Track page views (page name goes in properties)
datalyr.page({ title: 'Pricing', variant: 'A' });
```

---

## How It Works

1. Events are created with `track()`, `page()`, `identify()`, etc.
2. Each event includes device context, session data, and attribution parameters.
3. Events are queued locally and sent in batches.
4. If the browser is offline, events are stored and sent when connectivity returns.
5. Events are processed server-side for analytics and attribution reporting.

### Event Payload

Every event includes:

```javascript
{
  event_name: 'purchase',
  event_data: { ... },           // Custom + attribution + session properties

  // Identity
  anonymous_id: 'anon_xxxxx',    // Persistent browser ID
  distinct_id: 'user_123',       // user_id if identified, else anonymous_id
  user_id: 'user_123',           // Set after identify()
  session_id: 'sess_xxxxx',      // Current session

  // Context (in event_data)
  url: 'https://example.com/pricing',
  title: 'Pricing',
  referrer: 'https://google.com',

  // Attribution (in event_data, if captured)
  utm_source: 'facebook',
  fbclid: 'abc123',

  // Metadata
  workspace_id: 'wk_xxxxx',
  source: 'web',
  timestamp: '2024-01-15T10:30:00Z',
  sdk_version: '1.4.1',
  sdk_name: 'datalyr-web-sdk'
}
```

---

## Configuration

All properties of `DatalyrConfig`:

```typescript
datalyr.init({
  // Required
  workspaceId: string,

  // Endpoint
  endpoint?: string,                        // Default: 'https://ingest.datalyr.com'
  fallbackEndpoints?: string[],             // Default: [] - Additional endpoints to try on failure

  // Debugging
  debug?: boolean,                          // Default: false - Enable console logging

  // Batching
  batchSize?: number,                       // Default: 10 - Events per batch
  flushInterval?: number,                   // Default: 5000 - Flush interval in ms
  flushAt?: number,                         // Default: 10 - Flush when N events queued

  // Priority events (bypass normal batching)
  criticalEvents?: string[],               // Default: undefined (disabled). Events flushed immediately.
  highPriorityEvents?: string[],           // Default: undefined (disabled). Events given queue priority.

  // Session
  sessionTimeout?: number,                  // Default: 3600000 (60 min)
  trackSessions?: boolean,                  // Default: true

  // Attribution
  attributionWindow?: number,               // Default: 7776000000 (90 days)
  trackedParams?: string[],                 // Default: [] - Additional URL params to capture

  // Privacy
  respectDoNotTrack?: boolean,              // Default: false - Honor browser DNT header
  respectGlobalPrivacyControl?: boolean,    // Default: true - Honor GPC signal
  privacyMode?: 'standard' | 'strict',     // Default: 'standard' - 'strict' limits data collection

  // Cookies / Storage
  cookieDomain?: string | 'auto',           // Default: 'auto'
  cookieExpires?: number,                   // Default: 365 (days)
  secureCookie?: boolean | 'auto',          // Default: 'auto'
  sameSite?: 'Strict' | 'Lax' | 'None',    // Default: 'Lax'
  cookiePrefix?: string,                    // Default: '__dl_'

  // Performance
  enablePerformanceTracking?: boolean,      // Default: true - Collect navigation timing metrics
  enableFingerprinting?: boolean,           // Default: true - Minimal device fingerprinting (standard mode only)

  // Retry / Offline
  maxRetries?: number,                      // Default: 5
  retryDelay?: number,                      // Default: 1000 (ms)
  maxOfflineQueueSize?: number,             // Default: 100

  // SPA
  trackSPA?: boolean,                       // Default: true - Auto-track route changes
  trackPageViews?: boolean,                 // Default: true - Auto-track initial page view

  // Container scripts
  enableContainer?: boolean,                // Default: true - Load third-party scripts from dashboard

  // Auto-Identify (opt-in)
  autoIdentify?: boolean,                   // Default: false - Automatically identify users
  autoIdentifyForms?: boolean,              // Default: true - Capture email from forms (when autoIdentify enabled)
  autoIdentifyAPI?: boolean,                // Default: true - Capture email from API responses (when autoIdentify enabled)
  autoIdentifyShopify?: boolean,            // Default: true - Capture email from Shopify endpoints (when autoIdentify enabled)
  autoIdentifyTrustedDomains?: string[],    // Default: [] - Additional domains to trust for API capture

  // Plugins
  plugins?: DatalyrPlugin[],                // Default: [] - Custom plugin instances
});
```

---

## API Reference

### Event Tracking

#### `track(eventName, properties?)`

Track a custom event.

```typescript
track(eventName: string, properties?: EventProperties): void
```

```javascript
datalyr.track('signup_started');

datalyr.track('product_viewed', {
  product_id: 'SKU123',
  product_name: 'Blue Shirt',
  price: 29.99,
  currency: 'USD',
  category: 'Apparel',
});
```

#### `page(properties?)`

Track a page view. The page `title`, `url`, `path`, `search`, and `referrer` are captured automatically. Pass `properties` to add or override values.

```typescript
page(properties?: PageProperties): void
```

```javascript
// Track current page (all properties auto-captured)
datalyr.page();

// Override title, add custom properties
datalyr.page({ title: 'Pricing', variant: 'A' });

// Add custom properties
datalyr.page({ product_id: 'SKU123', source: 'search' });
```

Note: `page()` does not accept a name string as the first argument. To set the page name, pass it as `title` in the properties object.

#### `screen(screenName, properties?)`

Track a screen view. Intended for SPAs or hybrid apps.

```typescript
screen(screenName: string, properties?: Record<string, any>): void
```

```javascript
datalyr.screen('Dashboard');
datalyr.screen('Product Details', { product_id: 'SKU123' });
```

Internally fires a `pageview` event with the `screen` property set.

#### `trackAppDownloadClick(options)`

Track an app download click, then redirect to the app store. Fires a `$app_download_click` event with full attribution, flushes via `sendBeacon`, and redirects.

```typescript
trackAppDownloadClick(options: {
  targetPlatform: 'ios' | 'android';
  appStoreUrl: string;
}): void
```

```javascript
datalyr.trackAppDownloadClick({
  targetPlatform: 'ios',
  appStoreUrl: 'https://apps.apple.com/app/your-app/id123456789',
});
```

For Android Play Store URLs, attribution parameters are automatically encoded into the `referrer` query parameter for deterministic install attribution.

---

### User Identity

#### `identify(userId, traits?)`

Link the anonymous visitor to a known user. Rotates the session ID on call (prevents session fixation). User traits are encrypted at rest.

```typescript
identify(userId: string, traits?: UserTraits): void
```

```javascript
datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium',
  company: 'Acme Inc',
});
```

#### `alias(userId, previousId?)`

Create an alias linking one user ID to another. If `previousId` is omitted, the current anonymous ID is used.

```typescript
alias(userId: string, previousId?: string): void
```

```javascript
datalyr.alias('user_123', 'temp_user_456');
```

#### `group(groupId, traits?)`

Associate the current user with a group or account.

```typescript
group(groupId: string, traits?: Record<string, any>): void
```

```javascript
datalyr.group('company_abc', { name: 'Acme Inc', plan: 'enterprise' });
```

#### `reset()`

Clear user identity and start a new session. The anonymous ID is preserved.

```javascript
datalyr.reset();
```

#### `getAnonymousId()`

Returns the persistent anonymous ID assigned on first visit.

```typescript
getAnonymousId(): string
```

#### `getUserId()`

Returns the current user ID set by `identify()`, or `null` if not identified.

```typescript
getUserId(): string | null
```

#### `getDistinctId()`

Returns the distinct ID. This is `userId` if identified, otherwise `anonymousId`.

```typescript
getDistinctId(): string
```

---

### Session

#### `getSessionId()`

Returns the current session ID.

```typescript
getSessionId(): string
```

#### `startNewSession()`

Force-start a new session. Returns the new session ID.

```typescript
startNewSession(): string
```

```javascript
const newSessionId = datalyr.startNewSession();
```

#### `getSessionData()`

Returns the current session metadata, or `null` if no active session.

```typescript
getSessionData(): SessionData | null
```

```typescript
interface SessionData {
  id: string;
  startTime: number;
  lastActivity: number;
  pageViews: number;
  events: number;
  duration: number;
  isActive: boolean;
}
```

#### `ready()`

Returns a promise that resolves when async initialization is complete (encryption, container loading, initial page view).

```typescript
ready(): Promise<void>
```

```javascript
datalyr.init({ workspaceId: 'YOUR_WORKSPACE_ID' });
await datalyr.ready();
// Encryption is initialized, container is loaded, safe to track
```

---

### Attribution

#### `getAttribution()`

Returns the current captured attribution data.

```typescript
getAttribution(): Attribution
```

```javascript
const attribution = datalyr.getAttribution();
console.log(attribution.source, attribution.medium, attribution.campaign);
```

```typescript
interface Attribution {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  term?: string | null;
  content?: string | null;
  clickId?: string | null;
  clickIdType?: string | null;   // 'fbclid', 'gclid', 'oppref', etc.
  referrer?: string | null;
  referrerHost?: string | null;
  landingPage?: string | null;
  landingPath?: string | null;
  timestamp?: number;
  [key: string]: any;            // Custom tracked params
}
```

Captured automatically from URLs:

| Type | Parameters |
|------|------------|
| UTM | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` |
| Click IDs | `fbclid`, `gclid`, `ttclid`, `oppref`, `twclid`, `li_fat_id`, `msclkid` |
| Referrer | `referrer`, `landing_page` |

Attribution supports first-touch (90-day window), last-touch, and journey tracking.

#### `setAttribution(attribution)`

Manually set or override attribution data.

```typescript
setAttribution(attribution: Partial<Attribution>): void
```

```javascript
datalyr.setAttribution({
  source: 'partner',
  medium: 'referral',
  campaign: 'spring_promo',
});
```

#### `getJourney()`

Returns the customer journey as an array of touchpoints (up to 30).

```typescript
getJourney(): TouchPoint[]
```

```typescript
interface TouchPoint {
  timestamp: number;
  source?: string;
  medium?: string;
  campaign?: string;
  sessionId: string;
}
```

---

### Super Properties

Super properties are included with every subsequent event.

#### `setSuperProperties(properties)`

Merge properties into the super properties store.

```typescript
setSuperProperties(properties: Record<string, any>): void
```

```javascript
datalyr.setSuperProperties({ app_version: '2.1.0', environment: 'production' });
```

#### `unsetSuperProperty(propertyName)`

Remove a single super property by key.

```typescript
unsetSuperProperty(propertyName: string): void
```

```javascript
datalyr.unsetSuperProperty('environment');
```

#### `getSuperProperties()`

Returns a copy of the current super properties.

```typescript
getSuperProperties(): Record<string, any>
```

---

### Privacy and Consent

#### `optOut()`

Opt the user out of all tracking. Clears the event queue and persists the preference in a cookie.

```javascript
datalyr.optOut();
```

#### `optIn()`

Opt the user back in.

```javascript
datalyr.optIn();
```

#### `isOptedOut()`

Returns `true` if the user has opted out.

```typescript
isOptedOut(): boolean
```

#### `setConsent(consent)`

Set granular consent preferences.

```typescript
setConsent(consent: ConsentConfig): void
```

```javascript
datalyr.setConsent({
  analytics: true,
  marketing: false,
  preferences: true,
  sale: false       // CCPA "Do Not Sell"
});
```

```typescript
interface ConsentConfig {
  analytics?: boolean;
  marketing?: boolean;
  preferences?: boolean;
  sale?: boolean;
}
```

#### Privacy Modes

```javascript
// Standard mode (default) - normal fingerprinting + tracking
datalyr.init({ workspaceId: '...', privacyMode: 'standard' });

// Strict mode - minimal data collection, no fingerprinting
datalyr.init({ workspaceId: '...', privacyMode: 'strict' });
```

The SDK also respects `respectDoNotTrack` and `respectGlobalPrivacyControl` config flags.

---

### Queue and Network

#### `flush()`

Manually flush the event queue. Returns a promise that resolves when all queued events are sent.

```typescript
flush(): Promise<void>
```

```javascript
await datalyr.flush();
```

#### `getNetworkStatus()`

Returns the current network status as tracked by the SDK.

```typescript
getNetworkStatus(): NetworkStatus
```

```typescript
interface NetworkStatus {
  isOnline: boolean;
  lastOfflineAt: number | null;
  lastOnlineAt: number | null;
}
```

Events are automatically stored when offline and sent when connectivity returns.

---

### Container Scripts

Container scripts manage third-party tracking pixels (Meta, Google, TikTok) configured in your Datalyr dashboard.

#### `loadScript(scriptId)`

Trigger a container script by ID.

```typescript
loadScript(scriptId: string): void
```

```javascript
datalyr.loadScript('custom-script-id');
```

#### `getLoadedScripts()`

Returns an array of loaded script IDs.

```typescript
getLoadedScripts(): string[]
```

Container script tag installation (loads pixels from your dashboard config):

```html
<script defer src="https://track.datalyr.com/container.js"
        data-workspace-id="YOUR_WORKSPACE_ID"></script>
```

---

### Debugging

#### `getErrors()`

Returns an array of SDK errors (up to 50 most recent).

```typescript
getErrors(): ErrorInfo[]
```

```typescript
interface ErrorInfo {
  message: string;
  stack?: string;
  context?: any;
  timestamp: string;
  url: string;
}
```

```javascript
console.log(datalyr.getErrors());
```

Enable `debug: true` in config to log all SDK activity to the console.

---

### Lifecycle

#### `destroy()`

Tear down the SDK instance. Restores patched `history.pushState` / `replaceState`, removes event listeners, cleans up the queue, session, container iframes, auto-identify listeners, and encryption keys. Resets all in-memory state.

```typescript
destroy(): void
```

```javascript
datalyr.destroy();
```

---

## Web-to-App Attribution

Track users who click a "Download App" button on your website and attribute their app install back to the original web session.

### Flow

1. User clicks an ad and lands on your page (web SDK captures `fbclid`, UTMs, etc.)
2. User clicks "Download App" -- `trackAppDownloadClick()` fires with full attribution
3. User installs from App Store / Play Store
4. First app open -- mobile SDK recovers the web attribution:
   - **Android**: Deterministic match via Play Store `referrer` parameter (~95% accuracy)
   - **iOS**: IP-based match against recent web events within 24 hours (~90%+ accuracy)

### Usage

```javascript
document.querySelector('#download-btn').addEventListener('click', () => {
  datalyr.trackAppDownloadClick({
    targetPlatform: 'ios',
    appStoreUrl: 'https://apps.apple.com/app/your-app/id123456789',
  });
});
```

```javascript
// Android - attribution params auto-encoded into Play Store referrer
datalyr.trackAppDownloadClick({
  targetPlatform: 'android',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.yourapp',
});
```

### Requirements

- Web SDK initialized on the prelander page
- Mobile SDK (`@datalyr/react-native` or `@datalyr/swift`) installed in the app
- Attribution is recovered automatically on first app launch

---

## SPA Support

Route changes are tracked automatically when `trackSPA: true` (the default). The SDK patches `history.pushState`, `history.replaceState`, and listens for `popstate` and `hashchange` events. Attribution cache is cleared on each navigation so new URL parameters are captured.

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  trackSPA: true,        // default
  trackPageViews: true,  // auto-track initial page view, default
});

// Manual page tracking
datalyr.page({ title: 'Product Details', product_id: 'SKU-123' });
```

---

## Framework Integration

### React

```jsx
import { useEffect } from 'react';
import datalyr from '@datalyr/web';

function App() {
  useEffect(() => {
    datalyr.init({ workspaceId: 'YOUR_WORKSPACE_ID' });
  }, []);

  const handleClick = () => {
    datalyr.track('button_clicked', { button_name: 'CTA' });
  };

  return <button onClick={handleClick}>Click Me</button>;
}
```

### Vue

```vue
<script setup>
import { onMounted } from 'vue';
import datalyr from '@datalyr/web';

onMounted(() => {
  datalyr.init({ workspaceId: 'YOUR_WORKSPACE_ID' });
});

const trackClick = () => {
  datalyr.track('button_clicked');
};
</script>

<template>
  <button @click="trackClick">Click Me</button>
</template>
```

### Next.js

```tsx
// app/providers.tsx
'use client';

import { useEffect } from 'react';
import datalyr from '@datalyr/web';

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    datalyr.init({
      workspaceId: process.env.NEXT_PUBLIC_DATALYR_WORKSPACE_ID!,
      debug: process.env.NODE_ENV === 'development',
    });
  }, []);

  return <>{children}</>;
}

// app/layout.tsx
import { AnalyticsProvider } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <AnalyticsProvider>{children}</AnalyticsProvider>
      </body>
    </html>
  );
}
```

---

## TypeScript

All types are exported from the package:

```typescript
import datalyr from '@datalyr/web';
import type {
  DatalyrConfig,
  EventProperties,
  UserTraits,
  PageProperties,
  SessionData,
  Attribution,
  TouchPoint,
  ConsentConfig,
  DatalyrPlugin,
  FingerprintData,
  IngestEventPayload,
  IngestBatchPayload,
  NetworkStatus,
  ErrorInfo,
  PerformanceMetrics,
} from '@datalyr/web';
```

```typescript
const properties: EventProperties = {
  product_id: 'SKU-123',
  price: 99.99,
  quantity: 2,
};
datalyr.track('product_added', properties);

const traits: UserTraits = {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium',
};
datalyr.identify('user_123', traits);
```

### Plugin Interface

```typescript
interface DatalyrPlugin {
  name: string;
  initialize(datalyr: any): void;
  page?(properties: PageProperties): void;
  track?(eventName: string, properties: EventProperties): void;
  identify?(userId: string, traits: UserTraits): void;
  loaded?(): void;
}
```

---

## Troubleshooting

### Events not appearing

1. Verify `workspaceId` is correct.
2. Set `debug: true` and check the console.
3. Confirm `datalyr.getAnonymousId()` returns a value.
4. Check the Network tab for requests to `ingest.datalyr.com`.
5. Disable ad blockers or privacy extensions.

### SDK not initialized

```javascript
console.log('Anonymous ID:', datalyr.getAnonymousId());
console.log('Session ID:', datalyr.getSessionId());
console.log('User ID:', datalyr.getUserId());
console.log('Network:', datalyr.getNetworkStatus());
console.log('Errors:', datalyr.getErrors());
```

If these return `undefined`, the SDK is not initialized. Call `datalyr.init()` first.

### Async initialization

`init()` returns synchronously, but encryption and container loading happen asynchronously. If you need to ensure everything is ready before tracking:

```javascript
datalyr.init({ workspaceId: '...' });
await datalyr.ready();
datalyr.track('post_init_event');
```

### Next.js SSR

SDK methods only work in the browser. Always call them inside `useEffect` or other client-side hooks:

```jsx
'use client';
import { useEffect } from 'react';
import datalyr from '@datalyr/web';

useEffect(() => {
  datalyr.init({ workspaceId: '...' });
}, []);
```

### Script tag vs NPM

Use one installation method, not both. Using both creates duplicate instances.

---

## License

MIT
