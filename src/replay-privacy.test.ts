/** Unit tests for src/replay/privacy.ts (the scrub helpers). */
import { scrubAttributes, scrubNode, stripQuery } from './replay/privacy';

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
});
