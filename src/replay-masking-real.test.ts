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

describe('replay privacy defaults (real rrweb, through the recorder)', () => {
  const ctx = {
    workspaceId: 'ws', sdkVersion: '1.9.1', endpoint: 'https://replay.test/replay',
    getSessionId: () => 's', getVisitorId: () => 'v',
  };
  const html = `
    <img id="img" alt="Jane Doe portrait" src="https://cdn.test/p.jpg?sig=img-secret" srcset="https://cdn.test/p.jpg?w=1&t=srcset-secret 1x, https://cdn.test/p2.jpg?t=srcset2-secret 2x">
    <input id="in" placeholder="jane@placeholder.test" title="title-secret" aria-label="aria-secret" data-user="data-secret">
    <a id="a" href="https://shop.test/account?token=href-secret#frag-secret">Account</a>
    <form action="/reset?key=action-secret"></form>`;

  async function run(privacy?: any): Promise<string> {
    document.body.innerHTML = html;
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    const rec = new Recorder();
    const pushed: any[] = [];
    const push = (rec as any).push.bind(rec);
    (rec as any).push = (e: any) => { pushed.push(e); push(e); };
    rec.start(ctx, 'replay', privacy);
    // Mutations: a node added later, and attribute changes on existing ones.
    const late = document.createElement('img');
    late.setAttribute('alt', 'late-alt-secret');
    late.setAttribute('src', '/x.png?late=src-secret');
    document.body.appendChild(late);
    document.getElementById('a')!.setAttribute('href', '/next?token=mut-href-secret');
    document.getElementById('in')!.setAttribute('placeholder', 'mut-placeholder-secret');
    await new Promise(r => setTimeout(r, 30));
    const json = JSON.stringify(pushed);
    rec.stop(true);
    expect(pushed.some(e => e.type === 2)).toBe(true);
    expect(pushed.some(e => e.type === 3 && e.data.source === 0)).toBe(true);
    return json;
  }

  test('default: alt/placeholder/title/aria-label/data-* blanked; query + fragment cut from href/src/srcset/action', async () => {
    const json = await run(undefined);
    for (const secret of ['Jane Doe portrait', 'jane@placeholder', 'title-secret', 'aria-secret', 'data-secret',
      'img-secret', 'srcset-secret', 'srcset2-secret', 'href-secret', 'frag-secret', 'action-secret',
      'late-alt-secret', 'src-secret', 'mut-href-secret', 'mut-placeholder-secret']) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain('"alt":""');
    expect(json).toContain('https://shop.test/account"');
    expect(json).toContain('https://cdn.test/p.jpg 1x, https://cdn.test/p2.jpg 2x');
  });

  test('attributes: true, urlQuery: true → attributes kept as rrweb serialised them', async () => {
    const json = await run({ textMode: 'interactive', attributes: true, urlQuery: true });
    for (const kept of ['Jane Doe portrait', 'jane@placeholder', 'title-secret', 'aria-secret', 'data-secret',
      'img-secret', 'href-secret', 'action-secret', 'late-alt-secret', 'mut-href-secret']) {
      expect(json).toContain(kept);
    }
  });
});
