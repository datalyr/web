// D01 — a pending encrypted-identity read must not resurrect a logged-out user.
//
// hydrateEncryptedUserId() awaits storage.getEncrypted('dl_user_id_pii'). That read
// can still be in flight when the page calls reset() (logout): reset() clears the
// user id AND rotates the anonymous id. The read then resolves, and the completion
// check was only `!this.userId` — which reset() had just made true — so the previous
// user's address was written back onto the BRAND NEW anonymous id. Every subsequent
// wire event carried them, and the server-side assertion extractor then asserted the
// freshly-rotated device belongs to that person: the wrong person at capture.
//
// The fix stamps the hydration with the identity generation counter (already bumped
// by reset() and by every persisted identity change) and drops the result if the
// identity moved on while the read was in flight.

export {};

import { IdentityManager } from './identity';
import { storage } from './storage';

/** A read we can resolve by hand, so the race is deterministic. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('D01 — reset() during an in-flight identity hydration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = '__dl_visitor_id=; path=/; max-age=0';
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('does not restore the logged-out user onto the rotated anonymous id', async () => {
    const pending = deferred<string>();
    jest.spyOn(storage, 'getEncrypted').mockReturnValue(pending.promise as any);

    const identity = new IdentityManager();
    const anonBeforeLogout = identity.getAnonymousId();

    // Init kicks off hydration; the encrypted read has NOT resolved yet.
    const hydration = identity.hydrateEncryptedUserId();

    // The visitor logs out while that read is still pending.
    identity.reset();
    const anonAfterLogout = identity.getAnonymousId();
    expect(anonAfterLogout).not.toBe(anonBeforeLogout);

    // Now the stale read lands.
    pending.resolve('alice@buyer.io');
    await hydration;

    expect(identity.getUserId()).toBeNull();
    expect(identity.getDistinctId()).toBe(anonAfterLogout);
    expect(identity.getAnonymousId()).toBe(anonAfterLogout);
    expect(identity.getIdentityFields().user_id).toBeNull();
  });

  it('does not overwrite a user identified while the read was in flight', async () => {
    const pending = deferred<string>();
    jest.spyOn(storage, 'getEncrypted').mockReturnValue(pending.promise as any);

    const identity = new IdentityManager();
    const hydration = identity.hydrateEncryptedUserId();

    // A different account signs in before the stale read resolves.
    identity.identify('user_42');

    pending.resolve('alice@buyer.io');
    await hydration;

    expect(identity.getUserId()).toBe('user_42');
  });

  it('still hydrates when nothing disturbs the identity', async () => {
    const pending = deferred<string>();
    jest.spyOn(storage, 'getEncrypted').mockReturnValue(pending.promise as any);

    const identity = new IdentityManager();
    const hydration = identity.hydrateEncryptedUserId();

    pending.resolve('alice@buyer.io');
    await hydration;

    expect(identity.getUserId()).toBe('alice@buyer.io');
  });
});

// D02 — the privacy purges (optOut(), setConsent({ analytics: false })) delete the
// PII at rest but used to leave the identity generation untouched, so an encrypted
// read started during init() resolved AFTERWARDS and restored the very address the
// visitor had just asked us to forget. Every later event shipped their user_id
// again, and the next page load re-persisted it. invalidateIdentity() closes it.
describe('D02 — a privacy purge during an in-flight identity hydration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = '__dl_visitor_id=; path=/; max-age=0';
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('invalidateIdentity() drops a read that lands after the purge, keeping the device id', async () => {
    const pending = deferred<string>();
    jest.spyOn(storage, 'getEncrypted').mockReturnValue(pending.promise as any);

    const identity = new IdentityManager();
    const anonBefore = identity.getAnonymousId();
    const hydration = identity.hydrateEncryptedUserId();

    // The visitor opts out: the keys are removed AND the identity is invalidated.
    localStorage.removeItem('dl_user_id');
    localStorage.removeItem('dl_user_id_pii');
    localStorage.removeItem('dl_user_traits');
    identity.invalidateIdentity();

    pending.resolve('alice@buyer.io');
    await hydration;

    expect(identity.getUserId()).toBeNull();
    expect(identity.getIdentityFields().user_id).toBeNull();
    expect(localStorage.getItem('dl_user_id_pii')).toBeNull();
    expect(localStorage.getItem('dl_user_id')).toBeNull();
    // Unlike reset(), an opt-out keeps the visitor's own id: there is nothing
    // left to unlink it from, and rotating it would start a new visitor.
    expect(identity.getAnonymousId()).toBe(anonBefore);
  });

  it('bumps the generation so identity-derived reads awaiting it are discarded too', () => {
    const identity = new IdentityManager();
    const generation = identity.getIdentityGeneration();
    identity.invalidateIdentity();
    expect(identity.getIdentityGeneration()).not.toBe(generation);
  });

  it('dedupes concurrent hydrations onto a single encrypted read', async () => {
    const pending = deferred<string>();
    const read = jest.spyOn(storage, 'getEncrypted').mockReturnValue(pending.promise as any);

    const identity = new IdentityManager();
    const first = identity.hydrateEncryptedUserId();
    const second = identity.hydrateEncryptedUserId();

    pending.resolve('alice@buyer.io');
    await Promise.all([first, second]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(identity.getUserId()).toBe('alice@buyer.io');

    // The handle is released once the read settles, so a later hydration runs.
    await identity.hydrateEncryptedUserId();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
