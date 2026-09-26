/**
 * Input masking against the REAL rrweb record() (not mocked): no input value, whatever
 * its type (hidden, untyped, unusual), textarea or select value may reach an event.
 */
const events: any[] = [];

import { record } from '@rrweb/record';
import { Recorder } from './replay/recorder';

describe('replay input masking (real rrweb)', () => {
  test('hidden, untyped and unusual inputs, textarea and select are masked', async () => {
    document.body.innerHTML = `
      <form>
        <input type="hidden" name="contact[email]" value="jane@secret.test">
        <input name="untyped" value="untyped-secret">
        <input type="foo" value="weird-secret">
        <input type="text" value="text-secret">
        <input type="password" value="pw-secret">
        <textarea>area-secret</textarea>
        <select><option value="sel-secret" selected>sel-secret</option></select>
      </form>`;
    const rec = new Recorder();
    // Capture the options the recorder passes, then run the real record() with them.
    const spy = jest.spyOn(require('@rrweb/record'), 'record');
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    rec.start({
      workspaceId: 'ws', sdkVersion: '1.8.1', endpoint: 'https://replay.test/replay',
      getSessionId: () => 's', getVisitorId: () => 'v',
    });
    const opts = spy.mock.calls[0]?.[0] as any;
    rec.stop(true);
    expect(opts).toBeDefined();
    const stop = record({ ...opts, emit: (e: any) => events.push(e) });
    // A later value change goes through the mutation/input paths too.
    const hidden = document.querySelector('input[type=hidden]') as HTMLInputElement;
    hidden.setAttribute('value', 'late-secret@x.test');
    const untyped = document.querySelector('input[name=untyped]') as HTMLInputElement;
    untyped.value = 'typed-secret';
    untyped.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    stop?.();
    const json = JSON.stringify(events);
    expect(events.some(e => e.type === 2)).toBe(true);
    for (const secret of ['jane@secret', 'untyped-secret', 'weird-secret', 'text-secret', 'pw-secret',
      'area-secret', 'late-secret', 'typed-secret']) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain('*'.repeat('jane@secret.test'.length));
  });
});
