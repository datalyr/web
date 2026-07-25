# @datalyr/web

Browser SDK for event tracking, user identity, and attribution. Version 1.7.8.

Full reference: [Web SDK](https://docs.datalyr.com/sdk-reference/web).

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [What the SDK tracks without your code](#what-the-sdk-tracks-without-your-code)
- [Events the SDK sends for you](#events-the-sdk-sends-for-you)
- [Identity](#identity)
- [Configuration](#configuration)
- [Remote configuration](#remote-configuration)
- [Complete method list](#complete-method-list)
- [Event tracking](#event-tracking)
- [Attribution](#attribution)
- [Checkout metadata](#checkout-metadata)
- [Super properties](#super-properties)
- [Privacy and consent](#privacy-and-consent)
- [Queue, network, and limits](#queue-network-and-limits)
- [Storage](#storage)
- [Container scripts](#container-scripts)
- [Debugging](#debugging)
- [Web-to-app attribution](#web-to-app-attribution)
- [SPA support](#spa-support)
- [Framework integration](#framework-integration)
- [TypeScript](#typescript)
- [Verify the install](#verify-the-install)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

Choose one method.

> **Never load the script tag and the npm package together.** Two instances issue two
> `visitor_id` values for one person and split the journey.

### Script tag

```html
<script defer src="https://track.datalyr.com/dl.js"
        data-workspace-id="YOUR_WORKSPACE_ID"></script>
```

The script tag loads externally and initializes on its own. Reach the SDK at
`window.datalyr`.

The script tag reads these attributes:

| Attribute | Required | Effect |
| --- | --- | --- |
| `data-workspace-id` | Yes | The workspace that receives events. |
| `data-endpoint` | No | Overrides the ingest URL. |
| `data-tracked-params` | No | More URL parameters to capture. Comma-separated. |
| `data-debug` | No | `true` turns on console logging. |
| `data-auto-identify` | No | `true` or `false`. |
| `data-platform` | No | `shopify`, `checkoutchamp`, or `generic`. |
| `data-checkout-champ-domains` | No | Comma-separated domains. |
| `data-stripe-payment-links` | No | `false` turns off Stripe link decoration. |
| `data-stripe-link-domains` | No | Comma-separated extra Stripe domains. |

### npm

```bash
npm install @datalyr/web
```

| Property | Script tag | npm |
| --- | --- | --- |
| Bundle cost | 0, loaded externally | 88 KB minified, 24 KB gzipped |
| TypeScript types | No | Yes |
| Access | `window.datalyr` | `import datalyr from '@datalyr/web'` |
| Initialize | Automatic | `datalyr.init()` |

---

## Quick start

```javascript
import datalyr from '@datalyr/web';

datalyr.init({ workspaceId: 'YOUR_WORKSPACE_ID' });

// Wait for encryption keys, container scripts, and the first page view
await datalyr.ready();

datalyr.track('button_clicked', { button: 'signup' });

datalyr.identify('user_123', { email: 'user@example.com' });

datalyr.page({ title: 'Pricing', variant: 'A' });
```

`init()` throws `Error('[Datalyr] workspaceId is required')` when `workspaceId` is
missing. A second `init()` call logs a warning and returns. Any tracking method called
before `init()` logs a warning and returns.

---

## What the SDK tracks without your code

Two triggers fire on their own.

| Trigger | Event name | Turn it off with |
| --- | --- | --- |
| First page view after load | `pageview` | `trackPageViews: false` |
| SPA route change — `pushState`, `replaceState`, `popstate`, `hashchange` | `pageview` | `trackSPA: false` |

Nothing else is automatic. The SDK records no clicks, scrolls, form submits, outbound
links, or errors. There is no session-start event. Session data rides on every event.
Call `track()` for everything else.

---

## Events the SDK sends for you

These names are reserved. Never send one through `track()` yourself.

| Method you call | Event name sent |
| --- | --- |
| `identify()` | `$identify` |
| `group()` | `$group` |
| `alias()` | `$alias` |
| `screen()` | `pageview`, with a `screen` property |
| `trackAppDownloadClick()` | `$app_download_click` |
| Auto-identify email capture | `$auto_identify`, then `$identify` |

### Event payload

```javascript
{
  event_name: 'purchase',
  event_data: { /* your properties, plus attribution, session, and context fields */ },

  // Identity
  visitor_id: 'anon_3d5cf66d-203f-4009-8bb0-f3714da152a4',
  distinct_id: 'user_123',
  user_id: 'user_123',
  session_id: 'sess_9f2c1b40-1c2e-4d55-9a0b-6a4f7f1d2e33',

  // Context, inside event_data
  url: 'https://example.com/pricing',
  title: 'Pricing',
  referrer: 'https://google.com',

  // Attribution, inside event_data
  utm_source: 'facebook',
  fbclid: 'abc123',

  // Metadata
  workspace_id: 'wk_xxxxx',
  source: 'web',
  timestamp: '2026-07-25T10:30:00Z',
  sdk_version: '1.7.8',
  sdk_name: 'datalyr-web-sdk'
}
```

---

## Identity

Four identifiers ship on every event. They are not alternatives to each other.

| Wire field | Value |
| --- | --- |
| `visitor_id` | The anonymous browser ID, format `anon_<uuid>`. Stays anonymous even after `identify()`. |
| `user_id` | The ID you pass to `identify()`. `null` until then. |
| `distinct_id` | The `user_id` when identified. The `visitor_id` before that. |
| `session_id` | Format `sess_<uuid>`. New after 60 minutes idle. |

Use `visitor_id` in server-side and webhook work. Stripe, Whop, and Shopify all key off
it. Use `distinct_id` when you reason about event-level identity.

The **Events** and **Conversions** tables label this column `distinct id`. For an
unidentified visitor it shows the `visitor_id`.

### Identity methods

| Method | Returns |
| --- | --- |
| `getVisitorId(): string` | The anonymous browser ID. Same value as `getAnonymousId()`. |
| `getAnonymousId(): string` | The anonymous browser ID. |
| `getUserId(): string \| null` | The identified user ID, or `null`. |
| `getDistinctId(): string` | The user ID when identified, otherwise the anonymous browser ID. |
| `getSessionId(): string` | The current session ID. |
| `getSessionData(): SessionData \| null` | The full session record. |
| `startNewSession(): string` | Ends the current session and returns a new session ID. |
| `getWorkspaceId(): string \| null` | The workspace ID passed to `init()`. |

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

### identify()

```typescript
identify(userId: string, traits?: UserTraits): void
```

```javascript
datalyr.identify('user_123', {
  email: 'user@example.com',
  name: 'John Doe',
  plan: 'premium',
});
```

Call `identify()` after sign-in. Traits are encrypted with AES-GCM before storage.
Passing a different `user_id` runs `reset()` first, so two people on one browser do not
merge. `identify()` does not rotate the session ID.

### reset()

```javascript
datalyr.reset();
```

> **Do not call `reset()` on every page load.** It issues a **new** `visitor_id`, which
> breaks the link between the campaign visit and the later conversion.

Call `reset()` on logout. It clears `user_id`, traits, super properties, the captured
email, the journey, and both touchpoints, then issues a new `visitor_id` and a new
session. It leaves the Meta `_fbc` and `_fbp` cookies in place.

### alias()

```typescript
alias(userId: string, previousId?: string): void
```

```javascript
datalyr.alias('user_123');
```

> **`previousId` accepts only the current anonymous ID.** Any other value logs
> `alias() only accepts the current anonymous ID as previousId` and does nothing. Omit the
> argument to use the current anonymous ID.

### group()

```typescript
group(groupId: string, traits?: Record<string, any>): void
```

```javascript
datalyr.group('company_abc', { name: 'Acme Inc', plan: 'enterprise' });
```

---

## Configuration

Only `workspaceId` is required.

> **`sessionTimeout` and `attributionWindow` are milliseconds, not minutes or days.**
> Setting `sessionTimeout: 60` expires the session after 60 milliseconds and starts a new
> session on every event.

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  sessionTimeout: 3600000,      // 60 minutes, in milliseconds
  attributionWindow: 7776000000, // 90 days, in milliseconds
  debug: true,
});
```

| Option | Type | Default |
| --- | --- | --- |
| `workspaceId` | `string` | Required. Throws when missing. |
| `endpoint` | `string` | `'https://ingest.datalyr.com'` |
| `fallbackEndpoints` | `string[]` | `[]`. Tried in order after the primary endpoint fails. |
| `debug` | `boolean` | `false` |
| `batchSize` | `number` events | `10`, clamped 1–1000 |
| `flushInterval` | `number` ms | `5000`, clamped 250–3600000 |
| `criticalEvents` | `string[]` | `['purchase', 'signup', 'subscribe', 'lead', 'conversion']`. Flushed immediately. |
| `highPriorityEvents` | `string[]` | `['add_to_cart', 'begin_checkout', 'view_item', 'search']`. Flushed after 1000 ms. |
| `sessionTimeout` | `number` ms | `3600000` — 60 minutes |
| `attributionWindow` | `number` ms | `7776000000` — 90 days |
| `trackedParams` | `string[]` | `[]`, merged onto the default list |
| `respectDoNotTrack` | `boolean` | `false` |
| `respectGlobalPrivacyControl` | `boolean` | `true` |
| `privacyMode` | `'standard' \| 'strict'` | `'standard'` |
| `cookieDomain` | `string \| 'auto'` | `'auto'` |
| `cookieExpires` | `number` days | `365` |
| `secureCookie` | `boolean \| 'auto'` | `'auto'` |
| `sameSite` | `'Strict' \| 'Lax' \| 'None'` | `'Lax'` |
| `cookiePrefix` | `string` | `'__dl_'` |
| `enablePerformanceTracking` | `boolean` | `true` |
| `enableFingerprinting` | `boolean` | `true`. Off in `strict` privacy mode. |
| `maxRetries` | `number` | `5`, clamped 0–20 |
| `retryDelay` | `number` ms | `1000`, clamped 0–60000 |
| `maxOfflineQueueSize` | `number` events | `100`, clamped 1–100000 |
| `trackSPA` | `boolean` | `true` |
| `trackPageViews` | `boolean` | `true` |
| `enableContainer` | `boolean` | `true`. Set `false` to skip dashboard-configured pixels. |
| `autoIdentify` | `boolean` | `false`. Forced `false` when `privacyMode` is `'strict'`. |
| `autoIdentifyForms` | `boolean` | `true`, applied only when `autoIdentify` is `true` |
| `autoIdentifyAPI` | `boolean` | `false`. A same-origin response scan can mis-identify. |
| `autoIdentifyShopify` | `boolean` | `true`, applied only when `autoIdentify` is `true` |
| `autoIdentifyTrustedDomains` | `string[]` | `[]` |
| `shopifyCartAttributes` | `boolean` | `false`. Becomes `true` when `platform` is `'shopify'`. |
| `platform` | `'shopify' \| 'checkoutchamp' \| 'generic'` | Unset |
| `checkoutChampDomains` | `string[]` | Unset |
| `stripePaymentLinks` | `boolean` | `true` |
| `stripeLinkDomains` | `string[]` | `[]` |
| `plugins` | `DatalyrPlugin[]` | `[]` |

### Options that do nothing

`DatalyrConfig` declares two options that no code reads. Setting either changes no
behavior.

| Option | Status |
| --- | --- |
| `flushAt` | Declared and given a default of `10`. Never read. Use `batchSize`. |
| `trackSessions` | Declared and given a default of `true`. Never read. Sessions are always tracked. |

---

## Remote configuration

Datalyr can set these nine options from the dashboard, under **Settings → Identity &
Attribution**, with no code change. The SDK receives them at runtime in the
`/container-scripts` response.

`autoIdentify`, `autoIdentifyForms`, `autoIdentifyAPI`, `autoIdentifyShopify`,
`shopifyCartAttributes`, `checkoutChampDomains`, `respectGlobalPrivacyControl`,
`respectDoNotTrack`, `privacyMode`.

Precedence per key: built-in default, then the dashboard value, then the explicit
`init()` value. A value you pass to `init()` always wins. Changes propagate within about
5 minutes because the response is edge-cached.

`platform` is not remote-configurable. Set it at install time with the `data-platform`
attribute. The CheckoutChamp behaviors run before the remote config arrives.

---

## Complete method list

| Method | Signature |
| --- | --- |
| `init` | `(config: DatalyrConfig) => void` |
| `ready` | `() => Promise<void>` |
| `track` | `(eventName: string, properties?: EventProperties) => void` |
| `identify` | `(userId: string, traits?: UserTraits) => void` |
| `page` | `(properties?: PageProperties) => void` |
| `screen` | `(screenName: string, properties?: Record<string, any>) => void` |
| `group` | `(groupId: string, traits?: Record<string, any>) => void` |
| `alias` | `(userId: string, previousId?: string) => void` |
| `reset` | `() => void` |
| `flush` | `() => Promise<void>` |
| `destroy` | `() => void` |
| `getWorkspaceId` | `() => string \| null` |
| `getVisitorId` | `() => string` |
| `getAnonymousId` | `() => string` |
| `getUserId` | `() => string \| null` |
| `getDistinctId` | `() => string` |
| `getSessionId` | `() => string` |
| `getSessionData` | `() => SessionData \| null` |
| `startNewSession` | `() => string` |
| `getAttribution` | `() => Attribution` |
| `getJourney` | `() => TouchPoint[]` |
| `setAttribution` | `(attribution: Partial<Attribution>) => void` |
| `getStripeMetadata` | `() => { client_reference_id: string; metadata: { visitor_id: string } }` |
| `getWhopCheckoutMetadata` | `() => { visitor_id: string }` |
| `trackAppDownloadClick` | `(options: { targetPlatform: 'ios' \| 'android'; appStoreUrl: string }) => Promise<void>` |
| `setConsent` | `(consent: ConsentConfig) => void` |
| `optOut` | `() => void` |
| `optIn` | `() => void` |
| `isOptedOut` | `() => boolean` |
| `setSuperProperties` | `(properties: Record<string, any>) => void` |
| `unsetSuperProperty` | `(propertyName: string) => void` |
| `getSuperProperties` | `() => Record<string, any>` |
| `getErrors` | `() => ErrorInfo[]` |
| `getNetworkStatus` | `() => NetworkStatus` |
| `loadScript` | `(scriptId: string) => void` |
| `getLoadedScripts` | `() => string[]` |

The default export and `window.datalyr` are one shared singleton.
`createDatalyrInstance()` returns a second independent instance.

`trackImmediate()` and `forceFlush()` are not public methods. Names in the bootstrap stub
that resemble them do not resolve to anything callable. Use `track()` and `flush()`.

---

## Event tracking

### track()

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

### page()

```typescript
page(properties?: PageProperties): void
```

The SDK captures `title`, `url`, `path`, `search`, and `referrer` on its own. Pass
`properties` to add or override values.

```javascript
datalyr.page();
datalyr.page({ title: 'Pricing', variant: 'A' });
```

`page()` does not accept a name string as its first argument. Pass the page name as
`title` inside the properties object.

Use `page()` only when automatic tracking is off, or for a second view on one URL.

### screen()

```typescript
screen(screenName: string, properties?: Record<string, any>): void
```

```javascript
datalyr.screen('Dashboard');
datalyr.screen('Product Details', { product_id: 'SKU123' });
```

`screen()` sends a `pageview` event with the `screen` property set.

### ready()

```typescript
ready(): Promise<void>
```

`init()` returns synchronously. Encryption setup, container loading, and the first page
view finish asynchronously. Await `ready()` when you need all three complete.

```javascript
datalyr.init({ workspaceId: 'YOUR_WORKSPACE_ID' });
await datalyr.ready();
datalyr.track('post_init_event');
```

---

## Attribution

```typescript
getAttribution(): Attribution
setAttribution(attribution: Partial<Attribution>): void
getJourney(): TouchPoint[]
```

```javascript
const attribution = datalyr.getAttribution();
console.log(attribution.source, attribution.medium, attribution.campaign);

datalyr.setAttribution({
  source: 'partner',
  medium: 'referral',
  campaign: 'spring_promo',
});
```

```typescript
interface Attribution {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  term?: string | null;
  content?: string | null;
  clickId?: string | null;
  clickIdType?: string | null;   // 'fbclid', 'gclid', 'ttclid', and the rest of the 15 below
  referrer?: string | null;
  referrerHost?: string | null;
  landingPage?: string | null;
  landingPath?: string | null;
  timestamp?: number;
  [key: string]: any;            // Your trackedParams
}

interface TouchPoint {
  timestamp: number;
  source?: string;
  medium?: string;
  campaign?: string;
  sessionId: string;
}
```

First touch and last touch persist for `attributionWindow`, 90 days by default. The
journey keeps the last 30 touchpoints.

### Click IDs captured

The SDK reads these 16 parameters from the URL. Matching is **case-sensitive**.
They are listed in precedence order, down the left column then down the right.

| Parameter | Platform | Parameter | Platform |
| --- | --- | --- | --- |
| `fbclid` | Meta | `li_fat_id` | LinkedIn |
| `gclid` | Google Ads | `sclid` | Snapchat |
| `gbraid` | Google Ads, iOS | `dclid` | Google Display |
| `wbraid` | Google Ads, web | `epik` | Pinterest |
| `ttclid` | TikTok | `rdt_cid` | Reddit |
| `oppref` | OpenAI Ads | `obclid` | Outbrain |
| `msclkid` | Microsoft | `irclid` | Impact |
| `twclid` | X | `ko_click_id` | Klaviyo |

Two parameters are normalized to a canonical name:

| In the URL | Stored as |
| --- | --- |
| `ScCid`, `sccid` | `sclid` |
| `irclickid` | `irclid` |

A URL carrying several click IDs sends all of them. `clickIdType` takes the first match in
the order of the table above. Any click ID forces `medium` to `cpc`.

`oppref` (OpenAI Ads) is captured **as of 1.7.8**. Earlier versions did not, so OpenAI Ads
web conversions from 1.7.7 and below delivered with `attribution_type: none` unless the
value was passed by hand. It is ordered after the Google click IDs, matching the iOS and
React Native SDKs, so it never outranks `fbclid` or `gclid` on a URL carrying both.

### Campaign parameters captured

| Group | Parameters |
| --- | --- |
| UTM | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` |
| Always captured | `lyr`, `ref`, `source`, `campaign`, `medium`, `gad_source` |
| Your `trackedParams` | Added to the rows above, never replacing them |

Each UTM is sent twice, under its full name and its stripped alias. `utm_source` also
arrives as `source`.

### Ad platform cookies read

| Platform | Cookies | Survives a marketing decline |
| --- | --- | --- |
| Meta | `_fbp`, `_fbc` | No |
| Google Ads | `_gcl_aw`, `_gcl_dc`, `_gcl_gb`, `_gcl_ha`, `_gac` | No |
| Google Analytics | `_ga`, `_gid` | Yes |
| TikTok | `_ttp`, `_ttc` | No |
| Snapchat | `_scid` | No |

Campaign parameters survive a marketing decline.

The SDK writes `_fbc` and `_fbp` itself when an `fbclid` arrives and Meta has not set
them. Both last 90 days.

---

## Checkout metadata

```javascript
const stripe = datalyr.getStripeMetadata();
// { client_reference_id: 'anon_...', metadata: { visitor_id: 'anon_...' } }

const whop = datalyr.getWhopCheckoutMetadata();
// { visitor_id: 'anon_...' }
```

Pass `getStripeMetadata()` into the Stripe object your server creates.

```javascript
// Server receives this from the browser, then creates the PaymentIntent
stripe.paymentIntents.create({
  amount: 4999,
  currency: 'usd',
  metadata: datalyrStripeMetadata.metadata,
});
```

The Datalyr Stripe webhook reads `client_reference_id` on a Checkout Session and
`metadata.visitor_id` on every other Stripe object.

### Automatic Stripe link decoration

With `stripePaymentLinks: true`, the default, the SDK stamps:

| Surface | Receives |
| --- | --- |
| `<a>` links to `buy.stripe.com`, plus any host in `stripeLinkDomains` | `client_reference_id`, and `prefilled_email` when an email is known |
| `<stripe-pricing-table>`, `<stripe-buy-button>` | The `client-reference-id` attribute only, never an email |

The SDK skips `prefilled_email` when `prefilled_email` or `locked_prefilled_email` is
already present, or when `privacyMode` is `'strict'`. It re-stamps on click and watches
the DOM for new links, debounced at 150 ms.

> **The SDK never decorates `checkout.stripe.com` URLs.** Stripe ignores these parameters
> on an already-created Checkout Session. The SDK also cannot reach links opened with
> `window.open()`, links inside an iframe, or links in shadow DOM. Call `getVisitorId()`
> and pass the value yourself in those cases.

---

## Super properties

Super properties attach to every later event. `reset()` clears them.

```typescript
setSuperProperties(properties: Record<string, any>): void
unsetSuperProperty(propertyName: string): void
getSuperProperties(): Record<string, any>
```

```javascript
datalyr.setSuperProperties({ app_version: '2.1.0', environment: 'production' });
datalyr.unsetSuperProperty('environment');
```

---

## Privacy and consent

```typescript
setConsent(consent: ConsentConfig): void
```

```javascript
datalyr.setConsent({
  analytics: true,
  marketing: false,
  preferences: true,
  sale: false,       // CCPA "Do Not Sell"
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

`setConsent()` is safe to call before `init()`. The SDK persists the choice and applies it
at initialization.

| Method | Effect |
| --- | --- |
| `optOut()` | Stops all tracking. Clears the queue. Writes the `__dl_opt_out` cookie. Stops Stripe link decoration. |
| `optIn()` | Resumes tracking. |
| `isOptedOut(): boolean` | The current opt-out state. |

`privacyMode: 'strict'` forces `autoIdentify` off, turns off fingerprinting, and stops
email prefill on Stripe links. The SDK honors Global Privacy Control by default. It
ignores Do Not Track unless `respectDoNotTrack` is `true`.

```javascript
datalyr.init({ workspaceId: 'YOUR_WORKSPACE_ID', privacyMode: 'strict' });
```

---

## Queue, network, and limits

```typescript
flush(): Promise<void>
getNetworkStatus(): NetworkStatus
```

```javascript
await datalyr.flush();
```

```typescript
interface NetworkStatus {
  isOnline: boolean;
  lastOfflineAt: number | null;
  lastOnlineAt: number | null;
}
```

The SDK stores events while the browser is offline and sends them when connectivity
returns.

| Limit | Value |
| --- | --- |
| Events per batch | 10, configurable to 1000 through `batchSize` |
| Flush interval | 5000 ms |
| High-priority flush | 1000 ms |
| Retries per batch | 5 |
| Offline queue | 100 events. The oldest is dropped first. |
| `keepalive` request body | 60000 bytes |
| `sendBeacon` chunk | 60000 bytes |
| Duplicate suppression | The last 1000 event hashes |
| Journey length | 30 touchpoints |
| Property nesting depth | 5 |
| Error buffer | 50 |
| Container script fetch | 3000 ms timeout |

There is no per-event size limit. Only the transport limits above apply.

### How failed requests behave

| Response | Behavior |
| --- | --- |
| `429` | The SDK waits for `Retry-After`, default 60 seconds. The batch moves to the offline queue. |
| `403` | The SDK backs off for 5 minutes and parks the batch in the offline queue. Origin configuration changes, so the batch is not discarded. |
| Other `4xx`, except `408` | Dropped permanently. Never retried. This is what a wrong `workspaceId` produces. |
| `5xx`, `408`, network failure | Retried with exponential backoff, up to `maxRetries`, then tried against each `fallbackEndpoints` host. |

---

## Storage

| Cookie | Value | Lifetime |
| --- | --- | --- |
| `__dl_visitor_id` | The `visitor_id` | 365 days |
| `__dl_opt_out` | `true` or `false` | `cookieExpires` |

The SDK writes `__dl_visitor_id` on the root domain with `SameSite=Lax`, and `Secure` on
HTTPS. A failed root-domain write falls back to a host-only cookie.

State lives in `localStorage` under a double `dl_dl_` prefix: `dl_dl_anonymous_id`,
`dl_dl_user_id`, `dl_dl_journey`, `dl_dl_first_touch`, `dl_dl_last_touch`,
`dl_dl_offline_queue`. Traits and the captured email are encrypted with AES-GCM.

---

## Container scripts

Container scripts are the third-party pixels you configure in the Datalyr dashboard. The
container is built into `dl.js` and into the npm package. It loads on init. There is no
separate container snippet to install.

```typescript
loadScript(scriptId: string): void
getLoadedScripts(): string[]
```

```javascript
datalyr.loadScript('custom-script-id');
console.log(datalyr.getLoadedScripts());
```

The SDK skips the container when `enableContainer` is `false`, when the visitor opted
out, when `privacyMode` is `'strict'`, or when marketing consent is declined.

---

## Debugging

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

`getErrors()` returns the 50 most recent SDK errors. Set `debug: true` to log all SDK
activity to the console.

### destroy()

```typescript
destroy(): void
```

`destroy()` restores the patched `history.pushState` and `history.replaceState`, removes
every listener, and clears the queue, the session, container iframes, auto-identify
listeners, and encryption keys. Use it only when you tear the integration down for good.

---

## Web-to-app attribution

```typescript
trackAppDownloadClick(options: {
  targetPlatform: 'ios' | 'android';
  appStoreUrl: string;
}): Promise<void>
```

`trackAppDownloadClick()` fires a `$app_download_click` event with full attribution,
flushes through `sendBeacon`, then redirects to the store URL.

```javascript
document.querySelector('#download-btn').addEventListener('click', () => {
  datalyr.trackAppDownloadClick({
    targetPlatform: 'ios',
    appStoreUrl: 'https://apps.apple.com/app/your-app/id123456789',
  });
});
```

```javascript
datalyr.trackAppDownloadClick({
  targetPlatform: 'android',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.yourapp',
});
```

For an Android Play Store URL, the SDK encodes the attribution parameters into the
`referrer` query parameter.

The mobile SDK recovers the web attribution on first app open:

| Platform | Match |
| --- | --- |
| Android | Deterministic, through the Play Store `referrer` parameter |
| iOS | IP-based, against web events from the last 24 hours |

This flow needs the Web SDK on the prelander page, and `@datalyr/react-native` or
`@datalyr/swift` in the app.

---

## SPA support

The SDK tracks route changes while `trackSPA` is `true`, the default. It patches
`history.pushState` and `history.replaceState`, and listens for `popstate` and
`hashchange`. It clears the attribution cache on each navigation, so new URL parameters
are captured.

```javascript
datalyr.init({
  workspaceId: 'YOUR_WORKSPACE_ID',
  trackSPA: true,
  trackPageViews: true,
});
```

---

## Framework integration

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

SDK methods run in the browser only. Call them inside `useEffect` or another client-side
hook.

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
```

```tsx
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

### Plugin interface

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

## Verify the install

1. Open your published site in a private window.
2. Open **Events** in Datalyr.
3. Confirm a `pageview` arrives with your URL, within 30 seconds.

When nothing arrives, set `debug: true`, then call `getErrors()` and `getNetworkStatus()`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No events, network tab shows a `4xx` | Wrong `workspaceId`. The batch is dropped with no retry. | Copy the ID from **Settings → Tracking → Install** |
| No events, no network request | `init()` never ran, or the visitor opted out | Call `datalyr.getWorkspaceId()` and `datalyr.isOptedOut()` |
| No events, requests blocked | An ad blocker or a privacy extension | Test in a clean private window |
| A session expires on every event | `sessionTimeout` was set in minutes | Set it in milliseconds: `3600000` for 60 minutes |
| Attribution disappears after a few days | `attributionWindow` was set in days | Set it in milliseconds: `7776000000` for 90 days |
| Two `visitor_id` values for one person | The script tag and the npm package both loaded | Remove one |
| Conversions do not link to the visit | `reset()` runs on page load | Call `reset()` on logout only |
| A Snapchat or Impact click is not attributed | Uppercase or alias parameter | The SDK maps `ScCid`, `sccid`, and `irclickid` on its own. Confirm the parameter reaches the landing URL. |
| Stripe conversions are unattributed | A `checkout.stripe.com` link | Pass `getStripeMetadata()` from your server, or use a `buy.stripe.com` link |
| `undefined` from every getter | `init()` never ran | Call `datalyr.init()` first |

```javascript
console.log('Workspace:', datalyr.getWorkspaceId());
console.log('Visitor ID:', datalyr.getVisitorId());
console.log('Session ID:', datalyr.getSessionId());
console.log('User ID:', datalyr.getUserId());
console.log('Network:', datalyr.getNetworkStatus());
console.log('Errors:', datalyr.getErrors());
```

---

## License

MIT
