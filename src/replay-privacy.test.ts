/** Unit tests for src/replay/privacy.ts (the scrub helpers). */
import { BLANK_IMAGE, INLINE_DATA_MAX, scrubAttributes, scrubEvent, scrubNode, stripQuery } from './replay/privacy';

const DEF = { textMode: 'interactive' as const, attributes: false, urlQuery: false };

describe('replay privacy scrub', () => {
  test('stripQuery: query and fragment cut; data:/blob: untouched; srcset per candidate', () => {
    expect(stripQuery('https://a.test/p?x=1#y')).toBe('https://a.test/p');
    expect(stripQuery('#top')).toBe('');
    expect(stripQuery('data:image/svg+xml;utf8,<svg fill="#fff"/>')).toBe('data:image/svg+xml;utf8,<svg fill="#fff"/>');
    expect(stripQuery('a.jpg?w=1 1x, b.jpg?w=2 2x', true)).toBe('a.jpg 1x, b.jpg 2x');
    expect(stripQuery('a.jpg?w=1, b.jpg?w=2', true)).toBe('a.jpg, b.jpg');
  });

  test('link hrefs keep their query (stylesheets/fonts); other tags do not', () => {
    const link = { href: 'https://fonts.test/css?family=Inter' };
    scrubAttributes(link, DEF, 'link');
    expect(link.href).toBe('https://fonts.test/css?family=Inter');
    const node = { type: 2, tagName: 'DIV', attributes: {}, childNodes: [
      { type: 2, tagName: 'form', attributes: { action: '/r?k=1', 'aria-label': 'x', placeholder: 'p' }, childNodes: [] },
      { type: 2, tagName: 'video', attributes: { poster: '/p.jpg?s=1', src: 'blob:https://a/1' }, childNodes: [] },
    ] };
    scrubNode(node, DEF);
    expect(node.childNodes[0].attributes).toEqual({ action: '/r', 'aria-label': '', placeholder: '' });
    expect(node.childNodes[1].attributes).toEqual({ poster: '/p.jpg', src: 'blob:https://a/1' });
  });

  test('attributes true + urlQuery false: only URLs change; the reverse only blanks', () => {
    const a = { href: '/x?q=1', alt: 'kept' };
    scrubAttributes(a, { ...DEF, attributes: true }, 'a');
    expect(a).toEqual({ href: '/x', alt: 'kept' });
    const b = { href: '/x?q=1', alt: 'gone' };
    scrubAttributes(b, { ...DEF, urlQuery: true }, 'img');
    expect(b).toEqual({ href: '/x?q=1', alt: '' });
  });

  test('large inline images are replaced whatever the settings; small ones and remote URLs stay', () => {
    const photo = 'data:image/png;base64,' + 'A'.repeat(INLINE_DATA_MAX * 20);
    const icon = 'data:image/svg+xml;utf8,<svg/>';
    const OPEN = { textMode: 'marked' as const, attributes: true, urlQuery: true };
    for (const p of [DEF, OPEN]) {
      const a: Record<string, unknown> = { src: photo, srcset: `${photo} 2x`, poster: photo, alt: 'me' };
      scrubAttributes(a, p, 'img');
      expect(a.src).toBe(BLANK_IMAGE);
      expect(a.srcset).toBe('');
      expect(a.poster).toBe(BLANK_IMAGE);
      const b: Record<string, unknown> = { src: icon, href: 'https://a.test/x.png' };
      scrubAttributes(b, p, 'img');
      expect(b.src).toBe(icon);
      expect(b.href).toBe(p.urlQuery ? 'https://a.test/x.png' : 'https://a.test/x.png');
      const s: Record<string, unknown> = { style: `width:10px;background-image:url("${photo}")` };
      scrubAttributes(s, p, 'div');
      expect(s.style).toBe('width:10px;background-image:url()');
    }
  });

  test('attribute mutations and style diffs from rrweb are scrubbed too (the cropper case)', () => {
    const photo = 'data:image/jpeg;base64,' + 'B'.repeat(500_000);
    const ev = { type: 3, data: { source: 0, adds: [], attributes: [
      { id: 1, attributes: { src: photo } },
      { id: 2, attributes: { style: { backgroundImage: `url(${photo})`, color: 'red' } } },
      { id: 3, attributes: { style: { backgroundImage: [`url(${photo})`, 'important'] } } },
    ] } };
    scrubEvent(ev, { textMode: 'marked', attributes: true, urlQuery: true });
    const [m1, m2, m3] = ev.data.attributes;
    expect(m1.attributes.src).toBe(BLANK_IMAGE);
    expect((m2.attributes.style as Record<string, unknown>).backgroundImage).toBe('url()');
    expect((m2.attributes.style as Record<string, unknown>).color).toBe('red');
    expect(((m3.attributes.style as Record<string, unknown>).backgroundImage as string[])[0]).toBe('url()');
    expect(JSON.stringify(ev).length).toBeLessThan(2000);
  });
});
