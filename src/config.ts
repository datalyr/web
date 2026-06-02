/**
 * Remote SDK config (Auto Identity Bridge).
 *
 * The `/container-scripts` response carries a `config` object — the workspace
 * `sdk_config` with server-computed defaults already applied (e.g. auto-identify
 * OFF for sensitive/health verticals). This module folds that remote config
 * UNDER the caller's explicit init() options, so the dashboard controls behavior
 * with zero snippet edits while explicit code always wins.
 *
 * Precedence per key:  explicit init() value  >  remote config  >  built-in default
 */
import type { DatalyrConfig } from './types';

/** Subset of DatalyrConfig the worker may deliver via the config envelope. */
export interface SdkRemoteConfig {
  autoIdentify?: boolean;
  autoIdentifyForms?: boolean;
  autoIdentifyAPI?: boolean;
  autoIdentifyShopify?: boolean;
  shopifyCartAttributes?: boolean;
  checkoutChampDomains?: string[];
  // NOTE: `platform` is intentionally NOT here. It's an install-time snippet
  // attribute (data-platform) the installer sets, because the CC behaviors
  // (restoreFromURL, Pixel dedup) run BEFORE the remote config arrives — a
  // dashboard-set platform would silently not drive them.
  // Privacy-strict toggle:
  respectGlobalPrivacyControl?: boolean;
  respectDoNotTrack?: boolean;
  privacyMode?: 'standard' | 'strict';
}

/** Keys the remote config is allowed to fill on DatalyrConfig. */
const REMOTE_KEYS: ReadonlyArray<keyof SdkRemoteConfig> = [
  'autoIdentify',
  'autoIdentifyForms',
  'autoIdentifyAPI',
  'autoIdentifyShopify',
  'shopifyCartAttributes',
  'checkoutChampDomains',
  'respectGlobalPrivacyControl',
  'respectDoNotTrack',
  'privacyMode',
];

/**
 * Fold `remote` into `config` IN PLACE. Precedence per key:
 *   explicit init() value  >  remote (dashboard)  >  built-in default
 *
 * `explicitKeys` = the keys the CALLER passed to init() (before built-in
 * defaults were merged in). For any remote key NOT in that set, remote
 * OVERRIDES the built-in default. This is essential because some keys
 * (respectDoNotTrack, respectGlobalPrivacyControl, privacyMode) get a built-in
 * default at init() and are therefore never `undefined` — a naive
 * "fill-if-undefined" would silently ignore the dashboard for them.
 *
 * No-op when there's no remote config (older worker / container disabled /
 * failed fetch) — built-in defaults then stand.
 */
export function applyRemoteConfig(
  config: DatalyrConfig,
  remote?: SdkRemoteConfig | null,
  explicitKeys?: ReadonlySet<string>,
): void {
  if (!remote) return;
  const target = config as unknown as Record<string, unknown>;
  for (const key of REMOTE_KEYS) {
    const remoteVal = remote[key];
    if (remoteVal === undefined || remoteVal === null) continue;
    // Explicit init() always wins; otherwise remote overrides the built-in default.
    if (explicitKeys?.has(key)) continue;
    target[key] = remoteVal;
  }
}
