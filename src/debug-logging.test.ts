/**
 * W3: session rotation and the legacy-key migration printed console.log lines on
 * every site, debug or not. They now print only with `debug: true`.
 */
import { SessionManager } from './session';
import { storage } from './storage';

function datalyrLogs(spy: jest.SpyInstance): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('[Datalyr'));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

describe('SessionManager logs only in debug mode', () => {
  test('rotating the session id prints nothing without debug', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const session = new SessionManager();
    const before = session.getSessionId();
    const after = session.rotateSessionId();
    expect(after).not.toBe(before);
    expect(datalyrLogs(log)).toEqual([]);
    session.destroy();
  });

  test('rotating the session id is logged with debug', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const session = new SessionManager(30 * 60 * 1000, true);
    const after = session.rotateSessionId();
    expect(datalyrLogs(log).some((line) => line.includes('[Datalyr Session]') && line.includes(after))).toBe(true);
    session.destroy();
  });
});

describe('legacy key migration logs only in debug mode', () => {
  test('a migration prints nothing without debug', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    localStorage.setItem('__dl_dl_anonymous_id', 'anon_legacy');
    expect(storage.migrateFromLegacyPrefix()).toBe(1);
    expect(datalyrLogs(log)).toEqual([]);
  });

  test('a migration is logged with debug', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    localStorage.setItem('__dl_dl_anonymous_id', 'anon_legacy');
    expect(storage.migrateFromLegacyPrefix(true)).toBe(1);
    expect(datalyrLogs(log).some((line) => line.includes('Migrated 1 keys'))).toBe(true);
  });
});
