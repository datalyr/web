import { applyRemoteConfig, type SdkRemoteConfig } from './config';
import type { DatalyrConfig } from './types';

/**
 * applyRemoteConfig is the heart of the Auto Identity Bridge. It must enforce
 * the precedence:  built-in defaults  <-  remote (dashboard)  <-  explicit init().
 * These tests lock that in so a future change can't silently re-order it.
 *
 * It only reads/writes the REMOTE_KEYS allowlist and mutates in place, so a
 * partial config cast is sufficient.
 */
function makeConfig(overrides: Partial<DatalyrConfig> = {}): DatalyrConfig {
  return { workspaceId: 'ws_test', ...overrides } as DatalyrConfig;
}

describe('applyRemoteConfig — merge precedence', () => {
  it('is a no-op when there is no remote config (built-in defaults stand)', () => {
    const config = makeConfig({ autoIdentify: true });
    applyRemoteConfig(config, undefined, new Set());
    expect(config.autoIdentify).toBe(true);
    applyRemoteConfig(config, null, new Set());
    expect(config.autoIdentify).toBe(true);
  });

  it('remote overrides a built-in default when the key was NOT set explicitly', () => {
    // respectDoNotTrack gets a built-in default (false) at init, so it is never
    // undefined — the explicitKeys mechanism is what lets remote still win here.
    const config = makeConfig({ respectDoNotTrack: false });
    const remote: SdkRemoteConfig = { respectDoNotTrack: true };
    applyRemoteConfig(config, remote, new Set()); // empty: nothing was explicit
    expect(config.respectDoNotTrack).toBe(true);
  });

  it('explicit init() always wins over remote', () => {
    const config = makeConfig({ autoIdentify: false });
    const remote: SdkRemoteConfig = { autoIdentify: true };
    applyRemoteConfig(config, remote, new Set(['autoIdentify']));
    expect(config.autoIdentify).toBe(false);
  });

  it('fills a remote value when the key is absent from config', () => {
    const config = makeConfig();
    const remote: SdkRemoteConfig = { shopifyCartAttributes: true };
    applyRemoteConfig(config, remote, new Set());
    expect(config.shopifyCartAttributes).toBe(true);
  });

  it('skips undefined / null remote values (keeps existing)', () => {
    const config = makeConfig({ autoIdentify: true });
    const remote = {
      autoIdentify: undefined,
      autoIdentifyForms: null,
    } as unknown as SdkRemoteConfig;
    applyRemoteConfig(config, remote, new Set());
    expect(config.autoIdentify).toBe(true);
    expect(config.autoIdentifyForms).toBeUndefined();
  });

  it('applies checkoutChampDomains array from remote', () => {
    const config = makeConfig();
    const remote: SdkRemoteConfig = { checkoutChampDomains: ['checkout.example.com'] };
    applyRemoteConfig(config, remote, new Set());
    expect(config.checkoutChampDomains).toEqual(['checkout.example.com']);
  });

  it('does not touch keys outside the remote allowlist', () => {
    const config = makeConfig({ workspaceId: 'ws_keep' });
    // workspaceId is not a REMOTE_KEY — a malicious/extra remote field must not clobber it.
    const remote = { workspaceId: 'ws_evil', autoIdentify: true } as unknown as SdkRemoteConfig;
    applyRemoteConfig(config, remote, new Set());
    expect(config.workspaceId).toBe('ws_keep');
    expect(config.autoIdentify).toBe(true);
  });

  it('propagates privacyMode: strict from remote (caller applies the autoIdentify gate)', () => {
    const config = makeConfig();
    const remote: SdkRemoteConfig = { privacyMode: 'strict' };
    applyRemoteConfig(config, remote, new Set());
    expect(config.privacyMode).toBe('strict');
  });

  it('respects explicit for one key while still applying remote to another', () => {
    const config = makeConfig({ autoIdentify: false, respectDoNotTrack: false });
    const remote: SdkRemoteConfig = { autoIdentify: true, respectDoNotTrack: true };
    // autoIdentify was explicit (stays false); respectDoNotTrack was not (remote wins).
    applyRemoteConfig(config, remote, new Set(['autoIdentify']));
    expect(config.autoIdentify).toBe(false);
    expect(config.respectDoNotTrack).toBe(true);
  });
});
