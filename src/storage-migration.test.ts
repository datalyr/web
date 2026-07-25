// WEB-29 — the legacy-prefix migration must write a key that get() can read.
//
// It stripped '__dl_', producing the LOGICAL key ('dl_anonymous_id'). get()
// prepends this.prefix ('dl_'), so the value actually lives at
// 'dl_dl_anonymous_id'. The migration wrote to an unread address and then
// deleted the legacy key — destroying the visitor id rather than migrating it.

export {};

import { storage } from './storage';

describe('WEB-29 — legacy prefix migration', () => {
  beforeEach(() => localStorage.clear());

  it('migrates a legacy visitor id so it is actually readable afterwards', () => {
    localStorage.setItem('__dl_dl_anonymous_id', 'anon_legacy_visitor');

    const migrated = storage.migrateFromLegacyPrefix();

    expect(migrated).toBe(1);
    // The whole point: readable through the normal accessor.
    expect(storage.getString('dl_anonymous_id')).toBe('anon_legacy_visitor');
    // …and stored under the real double-prefixed key.
    expect(localStorage.getItem('dl_dl_anonymous_id')).toBe('anon_legacy_visitor');
    // …with the legacy key cleaned up.
    expect(localStorage.getItem('__dl_dl_anonymous_id')).toBeNull();
  });

  it('does not overwrite a value the current visitor already has', () => {
    localStorage.setItem('__dl_dl_anonymous_id', 'anon_old');
    localStorage.setItem('dl_dl_anonymous_id', 'anon_current');

    storage.migrateFromLegacyPrefix();

    expect(storage.getString('dl_anonymous_id')).toBe('anon_current');
  });

  it('never writes the un-prefixed logical key', () => {
    // Guards the original bug shape directly.
    // (uses the module singleton — SafeStorage is intentionally not exported)
    localStorage.setItem('__dl_dl_anonymous_id', 'anon_legacy_visitor');
    storage.migrateFromLegacyPrefix();
    expect(localStorage.getItem('dl_anonymous_id')).toBeNull();
  });
});
