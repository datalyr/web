# @datalyr/web

Browser analytics and attribution SDK for web applications. Track events, identify users, and capture attribution data across your website.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Event Tracking](#event-tracking)
  - [Custom Events](#custom-events)
  - [Page Views](#page-views)
  - [E-Commerce Events](#e-commerce-events)
- [User Identity](#user-identity)
  - [Anonymous ID](#anonymous-id)
  - [Identifying Users](#identifying-users)
  - [User Properties](#user-properties)
- [Attribution](#attribution)
  - [Automatic Capture](#automatic-capture)
  - [Custom Parameters](#custom-parameters)
- [Event Queue](#event-queue)
- [Offline Support](#offline-support)
- [Privacy and Consent](#privacy-and-consent)
- [SPA Support](#spa-support)
- [Container Scripts](#container-scripts)
- [Framework Integration](#framework-integration)
  - [React](#react)
  - [Vue](#vue)
  - [Next.js](#nextjs)
- [TypeScript](#typescript)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

### NPM Package

```bash
npm install @datalyr/web
```

### Script Tag

```html
<script defer src="https://track.datalyr.com/container.js"
        data-workspace-id="YOUR_WORKSPACE_ID"></script>
```

The script tag loads externally (zero bundle size) and auto-initializes. Use `window.datalyr` to access the SDK.

---

## Quick Start

```javascript
import datalyr from '@datalyr/web';

// Initialize
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

// Track events
datalyr.track('button_clicked', { button: 'signup' });

// Identify users
datalyr.identify('user_123', { email: 'user@example.com' });

// Track page views
datalyr.page('Pricing', { variant: 'A' });
```

---

## How It Works

The SDK collects events and sends them to the Datalyr backend for analytics and attribution.

### Data Flow

1. Events are created with `track()`, `page()`, or `identify()`
2. Each event includes device info, session data, and attribution parameters
3. Events are queued locally and sent in batches
4. If offline, events are stored and sent when connectivity returns
5. Events are processed server-side for analytics and attribution reporting

### Event Payload

Every event includes:

```javascript
{
  event: 'purchase',              // Event name
  properties: { ... },            // Custom properties

  // Identity
  anonymous_id: 'anon_xxxxx',     // Persistent browser ID
  user_id: 'user_123',            // Set after identify()
  session_id: 'sess_xxxxx',       // Current session

  // Context
  page_url: 'https://example.com/pricing',
  page_title: 'Pricing',
  referrer: 'https://google.com',

  // Attribution (if captured)
  utm_source: 'facebook',
  fbclid: 'abc123',

  // Timestamps
  timestamp: '2024-01-15T10:30:00Z',
}
```

---

## Configuration

```javascript
datalyr.init({
  // Required
  workspaceId: string,

  // Features
  debug?: boolean,                       // Console logging
  trackPageViews?: boolean,              // Track initial page view (default: true)
  trackSPA?: boolean,                    // Track SPA route changes (default: true)

  // Event Queue
  batchSize?: number,                    // Events per batch (default: 10)
  flushInterval?: number,                // Send interval ms (default: 5000)

  // Session
  sessionTimeout?: number,               // Session timeout ms (default: 1800000 / 30 min)

  // Privacy
  privacyMode?: 'standard' | 'strict',   // Privacy level (default: 'standard')
  respectDoNotTrack?: boolean,           // Honor browser DNT (default: false)
  respectGlobalPrivacyControl?: boolean, // Honor GPC (default: true)

  // Cookies
  cookieDomain?: string | 'auto',        // Cookie domain (default: 'auto')

  // Container
  enableContainer?: boolean,             // Load container scripts (default: true)

  // Custom
  trackedParams?: string[],              // Additional URL params to track
  plugins?: Plugin[],                    // Custom plugins
});
```

---

## Event Tracking

### Custom Events

Track any action on your website:

```javascript
// Simple event
datalyr.track('signup_started');

// Event with properties
datalyr.track('product_viewed', {
  product_id: 'SKU123',
  product_name: 'Blue Shirt',
  price: 29.99,
  currency: 'USD',
  category: 'Apparel',
});

// Event with value
datalyr.track('level_completed', {
  level: 5,
  score: 1250,
  time_seconds: 120,
});
```

### Page Views

Track navigation:

```javascript
// Track current page
datalyr.page();

// Track with name
datalyr.page('Pricing');

// Track with properties
datalyr.page('Product Details', {
  product_id: 'SKU123',
  source: 'search',
});
```

### E-Commerce Events

Standard e-commerce tracking:

```javascript
// View product
datalyr.track('Product Viewed', {
  product_id: 'SKU123',
  product_name: 'Blue Shirt',
  price: 29.99,
  currency: 'USD'
});

// Add to cart
datalyr.track('Add to Cart', {
  product_id: 'SKU123',
  quantity: 1,
  price: 29.99
});

// Start checkout
datalyr.track('Checkout Started', {
  cart_value: 59.98,
  currency: 'USD',
  item_count: 2
});

// Complete purchase
datalyr.track('Purchase', {
  order_id: 'ORD-456',
  total: 59.98,
  currency: 'USD',
  items: [
    { product_id: 'SKU123', quantity: 2, price: 29.99 }
  ]
});
```

---

## User Identity

### Anonymous ID

Every visitor gets a persistent anonymous ID on first visit:

```javascript
const anonymousId = datalyr.getAnonymousId();
// 'anon_a1b2c3d4e5f6'
```

This ID:
- Persists across browser sessions
- Links events before and after user identification
- Can be passed to your backend for server-side attribution

### Identifying Users

Link the anonymous ID to a known user:

```javascript
datalyr.identify('user_123', {
  email: 'user@example.com',
});
```

After `identify()`:
- All future events include `user_id`
- Historical anonymous events can be linked server-side
- Attribution data is preserved on the user

### User Properties

Pass any user attributes:

```javascript
datalyr.identify('user_123', {
  // Standard fields
  email: 'user@example.com',
  name: 'John Doe',
  phone: '+1234567890',

  // Custom fields
  plan: 'premium',
  company: 'Acme Inc',
  signup_date: '2024-01-15',
});
```

### Logout

Clear user data on logout:

```javascript
datalyr.reset();
```

This:
- Clears the user ID
- Starts a new session
- Keeps the anonymous ID (same browser)

---

## Attribution

### Automatic Capture

The SDK captures attribution from URLs and referrers:

```javascript
const attribution = datalyr.getAttributionData();
```

Captured parameters:

| Type | Parameters |
|------|------------|
| UTM | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` |
| Click IDs | `fbclid`, `gclid`, `ttclid`, `twclid`, `li_fat_id`, `msclkid` |
| Referrer | `referrer`, `landing_page` |

Attribution is automatically included in all events and supports:
- First-touch attribution (90-day window)
- Last-touch attribution
- Customer journey tracking (up to 30 touchpoints)

### Custom Parameters

Track additional URL parameters:

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  trackedParams: ['ref', 'affiliate_id', 'promo_code']
});
```

---

## Event Queue

Events are batched for efficiency.

### Configuration

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  batchSize: 10,           // Send when 10 events queued
  flushInterval: 5000,     // Or every 5 seconds
});
```

### Manual Flush

Send all queued events immediately:

```javascript
await datalyr.flush();
```

### Priority Events

Important events like `Purchase`, `Signup`, and `Subscribe` are automatically prioritized for faster delivery.

---

## Offline Support

When the browser is offline:
- Events are stored locally
- Queue persists across page refreshes
- Events are sent when connectivity returns

```javascript
// Events work seamlessly offline
datalyr.track('Button Clicked'); // Automatically queued if offline

// Manually flush when ready
await datalyr.flush();
```

---

## Privacy and Consent

### Opt Out

```javascript
// Opt user out of tracking
datalyr.optOut();

// Opt user back in
datalyr.optIn();

// Check status
const isOptedOut = datalyr.isOptedOut();
```

### Consent Preferences

```javascript
datalyr.setConsent({
  analytics: true,
  marketing: false,
  preferences: true,
  sale: false  // CCPA "Do Not Sell"
});
```

### Privacy Modes

```javascript
// Standard mode (default)
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  privacyMode: 'standard'
});

// Strict mode - minimal data collection
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  privacyMode: 'strict'
});
```

---

## SPA Support

For single-page applications:

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  trackSPA: true  // Auto-track route changes (default: true)
});

// Manual route tracking
datalyr.page('Product Details', {
  product_id: 'SKU-123'
});
```

---

## Container Scripts

The SDK can load and manage third-party tracking scripts:

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  enableContainer: true  // Default: true
});

// Container scripts are loaded based on your dashboard configuration
// Supports: Meta (Facebook), Google, TikTok pixels
```

Security features:
- HTTPS-only script loading
- XSS protection
- URL validation
- CSP nonce support

---

## Framework Integration

### React

```jsx
import { useEffect } from 'react';
import datalyr from '@datalyr/web';

function App() {
  useEffect(() => {
    datalyr.init({
      workspaceId: 'YOUR_WORKSPACE_ID'
    });
  }, []);

  const handleClick = () => {
    datalyr.track('Button Clicked', { button_name: 'CTA' });
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
  datalyr.init({
    workspaceId: 'YOUR_WORKSPACE_ID'
  });
});

const trackClick = () => {
  datalyr.track('Button Clicked');
};
</script>

<template>
  <button @click="trackClick">Click Me</button>
</template>
```

### Next.js

```jsx
// app/providers.tsx
'use client';

import { useEffect } from 'react';
import datalyr from '@datalyr/web';

export function AnalyticsProvider({ children }) {
  useEffect(() => {
    datalyr.init({
      workspaceId: process.env.NEXT_PUBLIC_DATALYR_WORKSPACE_ID,
      debug: process.env.NODE_ENV === 'development'
    });
  }, []);

  return children;
}

// app/layout.tsx
import { AnalyticsProvider } from './providers';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <AnalyticsProvider>
          {children}
        </AnalyticsProvider>
      </body>
    </html>
  );
}
```

---

## TypeScript

```typescript
import datalyr, { EventProperties, UserTraits } from '@datalyr/web';

// Type-safe event properties
const properties: EventProperties = {
  product_id: 'SKU-123',
  price: 99.99,
  quantity: 2
};

datalyr.track('Product Added', properties);

// Type-safe user traits
const traits: UserTraits = {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium'
};

datalyr.identify('user_123', traits);
```

---

## Troubleshooting

### Events not appearing

1. Check workspace ID is correct
2. Enable `debug: true`
3. Verify `datalyr.getAnonymousId()` returns a value
4. Check Network tab for requests to `ingest.datalyr.com`
5. Disable ad blockers

### SDK not initialized

```javascript
// Check initialization
console.log('Anonymous ID:', datalyr.getAnonymousId());
console.log('Session ID:', datalyr.getSessionId());
console.log('Errors:', datalyr.getErrors());
```

If these return `undefined`, the SDK isn't initialized.

### Next.js SSR issues

Make sure you're calling SDK methods client-side only:

```jsx
'use client';

import { useEffect } from 'react';
import datalyr from '@datalyr/web';

useEffect(() => {
  // SDK methods only work in browser
  datalyr.init({ workspaceId: '...' });
}, []);
```

### Script tag vs NPM

Choose one installation method. Using both causes conflicts.

| Feature | Script Tag | NPM |
|---------|-----------|-----|
| Bundle Size | 0 (external) | ~15KB |
| TypeScript | No | Yes |
| Access | `window.datalyr` | `import datalyr` |
| Initialize | Automatic | `datalyr.init()` |

---

## License

MIT
