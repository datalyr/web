# @datalyr/web

The official Datalyr Web SDK for browser-based analytics. Track user behavior, measure conversions, and understand your customer journey with enterprise-grade analytics.

[![npm version](https://img.shields.io/npm/v/@datalyr/web.svg)](https://www.npmjs.com/package/@datalyr/web)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@datalyr/web)](https://bundlephobia.com/package/@datalyr/web)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@datalyr/web.svg)](https://github.com/datalyr/web-sdk/blob/main/LICENSE)

## Features

- 🚀 **Zero Configuration** - Start tracking with just your workspace ID
- 📦 **Lightweight** - ~15KB minified + gzipped with zero dependencies
- 🔒 **Privacy First** - GDPR compliant with built-in consent management
- 🎯 **Smart Batching** - Optimized network usage with intelligent event queuing
- 📱 **Cross-Platform** - Works on all modern browsers including mobile
- 🔄 **Offline Support** - Events are queued and sent when connection restored
- 🏷️ **Attribution Tracking** - Automatic UTM and click ID capture
- 🔍 **Session Management** - Automatic session tracking with configurable timeout
- 🎨 **TypeScript Support** - Full type definitions included
- 🔌 **Extensible** - Plugin system for custom functionality
- 📦 **Container Scripts** - Securely manage third-party pixels and tracking scripts

## Installation

```bash
npm install @datalyr/web
# or
yarn add @datalyr/web
# or
pnpm add @datalyr/web
```

## Quick Start

```javascript
import { Datalyr } from '@datalyr/web';

// Initialize with your workspace ID
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

// Initialize the SDK
await datalyr.init();

// Track an event
datalyr.track('Button Clicked', {
  button_name: 'Sign Up',
  location: 'Header'
});

// Identify a user
datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium'
});
```

## Core Methods

### Initialization

```javascript
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  
  // Optional configuration
  // endpoint: 'https://custom.endpoint.com',  // Optional: Custom endpoint
  debug: false,                             // Enable debug logging
  // batchSize: 10,                           // Optional: Events per batch
  // flushInterval: 5000,                     // Optional: Flush interval (ms)
  sessionTimeout: 1800000,                 // 30 minutes
  privacyMode: 'standard',                 // 'standard' or 'strict'
  respectDoNotTrack: false,                // Honor browser DNT
  respectGlobalPrivacyControl: true,       // Honor GPC
  cookieDomain: 'auto',                    // Auto-detect for subdomains
  trackSPA: true,                          // Track SPA route changes
  trackPageViews: true                     // Track initial page view
});

await datalyr.init();
```

### Track Events

Track custom events with properties:

```javascript
// Simple event
datalyr.track('Video Played');

// Event with properties
datalyr.track('Product Viewed', {
  product_id: 'SKU-123',
  product_name: 'Premium Widget',
  category: 'Electronics',
  price: 99.99,
  currency: 'USD'
});

// E-commerce events
datalyr.track('Purchase', {
  order_id: 'ORD-456',
  total: 299.99,
  currency: 'USD',
  items: [
    { product_id: 'SKU-123', quantity: 2, price: 99.99 },
    { product_id: 'SKU-456', quantity: 1, price: 100.01 }
  ]
});
```

### Identify Users

Associate events with users:

```javascript
// Identify with user ID only
datalyr.identify('user_123');

// Identify with traits
datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe',
  firstName: 'John',
  lastName: 'Doe',
  phone: '+1234567890',
  plan: 'premium',
  createdAt: '2024-01-01'
});

// Update user traits without changing ID
datalyr.identify(null, {
  plan: 'enterprise',
  company: 'Acme Corp'
});
```

### Page Tracking

Track page views:

```javascript
// Track current page
datalyr.page();

// Track with custom properties
datalyr.page({
  title: 'Pricing Page',
  category: 'Marketing',
  author: 'Marketing Team'
});

// Track with page name
datalyr.page('Pricing', {
  plan: 'premium',
  variant: 'A'
});
```

### Managing Identity

```javascript
// Get current user IDs
const anonymousId = datalyr.getAnonymousId();
const userId = datalyr.getUserId();
const distinctId = datalyr.getDistinctId();

// Reset identity (for logout)
datalyr.reset();

// Create alias (link anonymous to identified user)
datalyr.alias('user_123');
```

### User Consent

Manage user privacy preferences:

```javascript
// Opt user out of tracking
datalyr.optOut();

// Opt user back in
datalyr.optIn();

// Check opt-out status
const isOptedOut = datalyr.isOptedOut();

// Set consent preferences
datalyr.setConsent({
  analytics: true,
  marketing: false,
  preferences: true,
  sale: false  // CCPA "Do Not Sell"
});
```

### Session Management

```javascript
// Get current session ID
const sessionId = datalyr.getSessionId();

// Manually end session
datalyr.endSession();

// Start new session
datalyr.startNewSession();
```

## Advanced Features

### Event Priority

Important events like purchases are automatically prioritized for faster delivery:

```javascript
// Important conversion events
datalyr.track('Purchase', { value: 99.99 });
datalyr.track('Signup', { plan: 'premium' });
datalyr.track('Subscribe', { plan: 'annual' });

// E-commerce events  
datalyr.track('Add to Cart', { product_id: 'SKU-123' });
datalyr.track('Begin Checkout', { cart_value: 199.99 });
```

### Attribution Tracking

The SDK automatically captures:
- UTM parameters (utm_source, utm_medium, utm_campaign, utm_term, utm_content)
- Click IDs (gclid, fbclid, ttclid, msclkid, twclid, li_fat_id)
- Referrer information
- Landing page
- Customer journey touchpoints

```javascript
// Attribution data is automatically added to events
datalyr.track('Signup');
// Includes: utm_source, utm_medium, first_touch_source, last_touch_source, etc.

// Track custom URL parameters
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  trackedParams: ['ref', 'affiliate_id', 'promo_code']
});
```

### SPA Support

For single-page applications:

```javascript
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  trackSPA: true  // Auto-track route changes (default: true)
});

// Manual route tracking
datalyr.page('Product Details', {
  product_id: 'SKU-123'
});
```

### Privacy Modes

Control data collection:

```javascript
// Standard mode (default) - balanced privacy
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  privacyMode: 'standard'
});

// Strict mode - minimal data collection
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  privacyMode: 'strict'
});
```

### Offline Support

Events are automatically saved when offline and sent when connection is restored:

```javascript
// Events work seamlessly offline
datalyr.track('Button Clicked'); // Automatically queued if offline

// Manually flush pending events
await datalyr.flush();
```

### Cross-Subdomain Tracking

Automatically track users across subdomains:

```javascript
// Auto-detect domain for *.example.com
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  cookieDomain: 'auto'  // Default
});

// Or set explicitly
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  cookieDomain: '.example.com'
});
```

### Container Scripts

The SDK can automatically load and manage third-party tracking scripts with built-in security:

```javascript
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  enableContainer: true  // Default: true
});

// Container scripts are loaded automatically based on your
// configuration in the Datalyr dashboard

// Manually trigger a custom script
datalyr.loadScript('custom-script-id');

// Get list of loaded scripts
const loadedScripts = datalyr.getLoadedScripts();
```

The container manager supports:
- **Third-party pixels**: Meta (Facebook), Google, TikTok
- **Custom scripts**: Inline JavaScript or external scripts
- **Tracking pixels**: Image-based tracking pixels
- **Conditional loading**: Based on URL, device type, etc.
- **Frequency control**: Once per session, once per page, or always

**Security Features:**
- ✅ HTTPS-only script loading (except localhost)
- ✅ XSS protection with pattern detection
- ✅ URL validation and protocol blocking
- ✅ CSP nonce support for inline scripts
- ✅ Automatic async loading for better performance

### Plugins

Extend SDK functionality:

```javascript
// Create a plugin
const myPlugin = {
  name: 'my-plugin',
  
  initialize(datalyr) {
    console.log('Plugin initialized');
  },
  
  track(eventName, properties) {
    console.log('Event tracked:', eventName);
  },
  
  identify(userId, traits) {
    console.log('User identified:', userId);
  },
  
  page(properties) {
    console.log('Page tracked');
  }
};

// Register plugin
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  plugins: [myPlugin]
});
```

## TypeScript Support

Full TypeScript definitions are included:

```typescript
import { Datalyr, EventProperties, UserTraits } from '@datalyr/web';

const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

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

## Framework Integration

### React

```jsx
import { useEffect } from 'react';
import { Datalyr } from '@datalyr/web';

const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

function App() {
  useEffect(() => {
    datalyr.init();
  }, []);
  
  const handleClick = () => {
    datalyr.track('Button Clicked', {
      button_name: 'CTA'
    });
  };
  
  return <button onClick={handleClick}>Click Me</button>;
}
```

### Vue

```vue
<script setup>
import { onMounted } from 'vue';
import { Datalyr } from '@datalyr/web';

const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

onMounted(() => {
  datalyr.init();
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
import { Datalyr } from '@datalyr/web';

const datalyr = new Datalyr({
  workspaceId: process.env.NEXT_PUBLIC_DATALYR_WORKSPACE_ID
});

export function AnalyticsProvider({ children }) {
  useEffect(() => {
    datalyr.init();
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

## Best Practices

### 1. Initialize Early
Initialize the SDK as early as possible in your application lifecycle:

```javascript
// In your main entry file
import { Datalyr } from '@datalyr/web';

const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

// Initialize before other code
datalyr.init().then(() => {
  // Start your app
});
```

### 2. Use Consistent Event Naming
Adopt a naming convention for your events:

```javascript
// Good: Consistent, descriptive names
datalyr.track('Product Viewed');
datalyr.track('Cart Updated');
datalyr.track('Checkout Started');

// Avoid: Inconsistent naming
datalyr.track('view_product');
datalyr.track('Cart-Update');
datalyr.track('CHECKOUT_START');
```

### 3. Include Relevant Properties
Add properties that will help with analysis:

```javascript
// Good: Rich context
datalyr.track('Product Viewed', {
  product_id: 'SKU-123',
  product_name: 'Premium Widget',
  category: 'Electronics',
  price: 99.99,
  currency: 'USD',
  in_stock: true,
  view_type: 'quick_view'
});

// Avoid: Missing context
datalyr.track('Product Viewed', {
  id: '123'
});
```

### 4. Identify Users After Authentication
Call identify as soon as you know who the user is:

```javascript
// After login
async function handleLogin(email, password) {
  const user = await loginUser(email, password);
  
  // Identify immediately after login
  datalyr.identify(user.id, {
    email: user.email,
    name: user.name,
    plan: user.subscription
  });
}

// After signup
async function handleSignup(data) {
  const user = await createUser(data);
  
  datalyr.identify(user.id, {
    email: data.email,
    name: data.name,
    signup_date: new Date().toISOString()
  });
  
  datalyr.track('Signup Completed', {
    method: 'email'
  });
}
```

### 5. Handle Errors Gracefully
The SDK handles errors internally, but you can add your own error tracking:

```javascript
window.addEventListener('error', (event) => {
  datalyr.track('JavaScript Error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error?.toString()
  });
});
```

## Migration from Script Tag

If you're currently using the Datalyr script tag, migration is straightforward:

### Before (Script Tag):
```html
<script>
  window.datalyr = window.datalyr || [];
  window.datalyr.push(['init', { workspace_id: 'YOUR_WORKSPACE_ID' }]);
  window.datalyr.push(['track', 'Button Clicked']);
</script>
<script async src="https://cdn.datalyr.io/datalyr.js"></script>
```

### After (Web SDK):
```javascript
import { Datalyr } from '@datalyr/web';

const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID'
});

await datalyr.init();
datalyr.track('Button Clicked');
```

## Browser Support

The SDK supports all modern browsers:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Opera 76+

For older browsers, the SDK will gracefully degrade with fallback implementations.

## Performance

- **Bundle Size**: ~15KB minified + gzipped
- **Zero Dependencies**: No external dependencies
- **Optimized**: Smart event batching reduces network requests
- **Fast**: Deferred loading for non-critical operations
- **Memory Management**: Automatic cleanup of resources

## Privacy & Compliance

The SDK is designed with privacy in mind:

- **GDPR Compliant**: Built-in consent management
- **CCPA Support**: "Do Not Sell" preference support  
- **Cookie Control**: Configurable cookie settings
- **Data Minimization**: Collect only what you need
- **User Rights**: Easy opt-out and data deletion

## Debugging

Enable debug mode for detailed logging:

```javascript
const datalyr = new Datalyr({
  workspaceId: 'YOUR_WORKSPACE_ID',
  debug: true
});

// Check console for detailed logs:
// [Datalyr] Event tracked: Button Clicked
// [Datalyr] Events sent successfully
```

## API Reference

### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workspaceId` | `string` | *required* | Your Datalyr workspace ID |
| `endpoint` | `string` | Default API | Custom endpoint URL |
| `debug` | `boolean` | `false` | Enable debug logging |
| `batchSize` | `number` | `10` | Number of events per batch |
| `flushInterval` | `number` | `5000` | Time between flushes (ms) |
| `sessionTimeout` | `number` | `1800000` | Session timeout (ms) |
| `privacyMode` | `'standard' \| 'strict'` | `'standard'` | Privacy level |
| `respectDoNotTrack` | `boolean` | `false` | Honor browser DNT |
| `respectGlobalPrivacyControl` | `boolean` | `true` | Honor GPC |
| `cookieDomain` | `string \| 'auto'` | `'auto'` | Cookie domain |
| `trackSPA` | `boolean` | `true` | Track SPA routes |
| `trackPageViews` | `boolean` | `true` | Track page views |
| `enableContainer` | `boolean` | `true` | Enable secure container script loading |

### Methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize the SDK |
| `track(event, properties?)` | Track an event |
| `identify(userId?, traits?)` | Identify a user |
| `page(name?, properties?)` | Track a page view |
| `alias(userId)` | Create an alias |
| `reset()` | Reset identity |
| `optOut()` | Opt out of tracking |
| `optIn()` | Opt back in |
| `setConsent(config)` | Set consent preferences |
| `flush()` | Force send events |
| `getAnonymousId()` | Get anonymous ID |
| `getUserId()` | Get user ID |
| `getDistinctId()` | Get distinct ID |
| `getSessionId()` | Get session ID |
| `loadScript(scriptId)` | Manually trigger a container script |
| `getLoadedScripts()` | Get list of loaded container scripts |
| `destroy()` | Clean up resources |

## Support

- **Documentation**: [https://docs.datalyr.com](https://docs.datalyr.com)
- **Issues**: [GitHub Issues](https://github.com/datalyr/web-sdk/issues)
- **Email**: support@datalyr.com

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

Built with ❤️ by the Datalyr team