// WEB-22 — a PII user id must never be written to localStorage in the clear.
//
// The auto-identify path calls identify(email, { email }), so the raw address
// became the user_id and `dl_user_id` held it unencrypted — while the very same
// address was carefully encrypted into `dl_auto_identified_email` a few lines
// away. Measured 2026-07-25: on every workspace using auto-identify, 100% of
// events carrying a user_id had an email in that column (20,502 / 20,502 on
// f6260736 over 7 days).
//
// Per the 2026-07-25 decision, `user_id` ON THE WIRE is unchanged — the email
// still identifies the user server-side, so there is no identity discontinuity.
// Only the at-rest copy changes.

export {};

import { IdentityManager } from './identity';
import { storage } from './storage';
import { dataEncryption } from './encryption';

// jsdom ships `crypto` WITHOUT `subtle`, so `dataEncryption.initialize()` throws
// and every at-rest-encryption path is unreachable under test. Node's real
// WebCrypto is substituted so these tests exercise genuine encrypt/decrypt
// rather than a stub — this is the first coverage the encrypted-storage path
// has had (nothing else in the suite touches setEncrypted/getEncrypted).
const nodeWebCrypto = require('crypto').webcrypto;
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: nodeWebCrypto,
    configurable: true,
    writable: true,
  });
}
// jsdom also omits TextEncoder/TextDecoder, which encryption.ts uses to derive
// the key material.
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  Object.assign(globalThis, { TextEncoder, TextDecoder });
}

/** Every raw localStorage value, so we can assert an address appears nowhere. */
function rawLocalStorage(): string {
  return Object.keys(localStorage)
    .map((k) => `${k}=${localStorage.getItem(k)}`)
    .join('\n');
}

describe('WEB-22 — PII user ids are not persisted in plaintext', () => {
  beforeEach(async () => {
    localStorage.clear();
    await dataEncryption.initialize('ws-test', 'anon_device_test');
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('does not write an email into dl_user_id', async () => {
    const identity = new IdentityManager();
    identity.identify('someone@example.com', { email: 'someone@example.com' });

    expect(storage.getString('dl_user_id')).toBeNull();

    // Give the async encrypted write a turn, then assert the address is not
    // present in ANY key in the clear.
    await new Promise((r) => setTimeout(r, 0));
    expect(rawLocalStorage()).not.toContain('someone@example.com');
  });

  it('still returns the email as user_id in memory and on the wire', async () => {
    // The decision was explicitly to keep user_id semantics unchanged; only the
    // at-rest representation moves. If this ever fails, identity has forked.
    const identity = new IdentityManager();
    const link = identity.identify('someone@example.com', {});

    expect(identity.getUserId()).toBe('someone@example.com');
    expect(identity.getDistinctId()).toBe('someone@example.com');
    expect(link.user_id).toBe('someone@example.com');
  });

  it('restores a PII user id on the next page load via hydration', async () => {
    const first = new IdentityManager();
    first.identify('someone@example.com', {});
    await new Promise((r) => setTimeout(r, 0));

    // New instance = a fresh page load. The constructor is synchronous and
    // cannot decrypt, so the id arrives via hydrateEncryptedUserId().
    const second = new IdentityManager();
    expect(second.getUserId()).toBeNull();

    await second.hydrateEncryptedUserId();
    expect(second.getUserId()).toBe('someone@example.com');
  });

  it('leaves opaque (non-PII) user ids on the fast plaintext path', async () => {
    // No behaviour change for the overwhelming majority of integrations.
    const identity = new IdentityManager();
    identity.identify('usr_01HQ8ZK3', {});

    expect(storage.getString('dl_user_id')).toBe('usr_01HQ8ZK3');

    const fresh = new IdentityManager();
    expect(fresh.getUserId()).toBe('usr_01HQ8ZK3');
  });

  it('removes a plaintext email left behind by an older SDK version', async () => {
    // Upgrade path: 1.7.7 and earlier wrote the address in the clear. The first
    // identify() after upgrading must clean it up, not just stop adding to it.
    storage.set('dl_user_id', 'legacy@example.com');
    expect(storage.getString('dl_user_id')).toBe('legacy@example.com');

    const identity = new IdentityManager();
    identity.identify('legacy@example.com', {});
    await new Promise((r) => setTimeout(r, 0));

    expect(storage.getString('dl_user_id')).toBeNull();
    expect(rawLocalStorage()).not.toContain('legacy@example.com');
  });

  it('reset() clears the encrypted copy so logout leaves nothing at rest', async () => {
    const identity = new IdentityManager();
    identity.identify('someone@example.com', {});
    await new Promise((r) => setTimeout(r, 0));

    identity.reset();
    expect(identity.getUserId()).toBeNull();

    const after = new IdentityManager();
    await after.hydrateEncryptedUserId();
    expect(after.getUserId()).toBeNull();
    expect(rawLocalStorage()).not.toContain('someone@example.com');
  });

  it('hydration never overwrites an id already set this page load', async () => {
    const first = new IdentityManager();
    first.identify('old@example.com', {});
    await new Promise((r) => setTimeout(r, 0));

    const second = new IdentityManager();
    second.identify('new@example.com', {});
    await second.hydrateEncryptedUserId();

    expect(second.getUserId()).toBe('new@example.com');
  });

  it('falls back to memory-only — never plaintext — when crypto is unavailable', async () => {
    // http:// and legacy browsers have no crypto.subtle. index.ts is explicit
    // that encryption must not gate event delivery, so the id stays live in
    // memory; we only decline to persist an address we cannot protect.
    jest.spyOn(dataEncryption, 'encrypt').mockRejectedValue(new Error('no crypto.subtle'));

    const identity = new IdentityManager();
    identity.identify('nocrypto@example.com', {});

    expect(identity.getUserId()).toBe('nocrypto@example.com');

    await new Promise((r) => setTimeout(r, 0));
    expect(storage.getString('dl_user_id')).toBeNull();
    expect(rawLocalStorage()).not.toContain('nocrypto@example.com');
  });
});

describe('WEB-26 — defects found by the adversarial review', () => {
  beforeEach(async () => {
    localStorage.clear();
    await dataEncryption.initialize('ws-test', 'anon_device_test');
  });
  afterEach(() => { localStorage.clear(); jest.restoreAllMocks(); });

  it('an in-flight encrypted write cannot resurrect the id after reset()', async () => {
    // The race: setEncrypted is async and reset() is not, so reset()'s remove()
    // deleted nothing (the write had not landed) and the write then recreated
    // the key with the logged-out user's email.
    const identity = new IdentityManager();
    identity.identify('someone@example.com', {});
    identity.reset();                      // synchronously, before the write lands
    await new Promise((r) => setTimeout(r, 0));

    const after = new IdentityManager();
    await after.hydrateEncryptedUserId();
    expect(after.getUserId()).toBeNull();
    expect(rawLocalStorage()).not.toContain('someone@example.com');
  });

  it('migrates a legacy plaintext email even when identify() never runs again', async () => {
    // The population this fix exists for: AutoIdentifyManager short-circuits
    // while dl_auto_identified_email is present, so identify() is never called
    // again and persistUserId() never gets the chance to clean up.
    storage.set('dl_user_id', 'legacy@example.com');

    const identity = new IdentityManager();
    await identity.hydrateEncryptedUserId();
    await new Promise((r) => setTimeout(r, 0));

    expect(storage.getString('dl_user_id')).toBeNull();
    expect(identity.getUserId()).toBe('legacy@example.com');
    expect(rawLocalStorage()).not.toContain('legacy@example.com');
  });

  it('retries the write when identify() ran before encryption was keyed', async () => {
    // init() marks the SDK initialized before initializeAsync() finishes, so
    // identify(email) can reach persistUserId with no crypto key; that write
    // rejects and nothing is persisted.
    const spy = jest.spyOn(dataEncryption, 'encrypt').mockRejectedValueOnce(new Error('not initialized'));
    const identity = new IdentityManager();
    identity.identify('early@example.com', {});
    await new Promise((r) => setTimeout(r, 0));
    spy.mockRestore();

    await identity.hydrateEncryptedUserId();
    await new Promise((r) => setTimeout(r, 0));

    const restored = new IdentityManager();
    await restored.hydrateEncryptedUserId();
    expect(restored.getUserId()).toBe('early@example.com');
  });

  it('an opaque id clears a previous user\'s encrypted email', async () => {
    const first = new IdentityManager();
    first.identify('previous@example.com', {});
    await new Promise((r) => setTimeout(r, 0));

    const second = new IdentityManager();
    second.identify('usr_opaque_01', {});
    await new Promise((r) => setTimeout(r, 0));

    const third = new IdentityManager();
    await third.hydrateEncryptedUserId();
    expect(third.getUserId()).toBe('usr_opaque_01');
    expect(rawLocalStorage()).not.toContain('previous@example.com');
  });
});
