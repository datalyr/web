/**
 * Merchant-chosen privacy (1.9.1) applied inside the replay module: text masking per
 * textMode, and a scrub of rrweb's serialized nodes for attributes/urlQuery.
 *
 * rrweb 2.1.6 has no attribute-masking option (no maskAttributeFn; only input VALUES and
 * text nodes are maskable), so attributes and URLs are POST-PROCESSED: every FullSnapshot
 * node tree, every mutation's added node trees and every attribute mutation is rewritten
 * in onEmit before it is buffered; heat mode runs the same scrub on its one snapshot.
 *
 * Contract: datalyr-v2 docs/implementation/session-replay-2026-09-26/CHECKLIST.md
 * ("Privacy settings" under Interfaces).
 */
import type { ReplayPrivacy } from '../replay-loader';

export const TEXT_UNMASK_SELECTOR = 'button, a, label, [role=button], summary, [data-dl-unmask]';
export const TEXT_FORCE_MASK_SELECTOR = '[data-dl-mask]';
/** textMode 'all': only what the merchant marked by hand stays readable. */
const TEXT_UNMASK_ALL_SELECTOR = '[data-dl-unmask]';

/** Attributes whose VALUE is blanked when privacy.attributes is false. data-* too. */
export const MASKED_ATTRIBUTES = new Set(['alt', 'title', 'placeholder', 'aria-label']);
/** URL-valued attributes whose query/fragment is cut when privacy.urlQuery is false. */
export const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href']);

function star(text: string): string {
  return text.replace(/[\S]/g, '*');
}

function inside(element: HTMLElement | null, selector: string): boolean {
  return !!(element && element.closest && element.closest(selector));
}

/**
 * rrweb maskTextFn for a textMode (rrweb runs it on every text node, maskTextSelector '*'):
 * - 'interactive': keep text inside TEXT_UNMASK_SELECTOR unless inside [data-dl-mask]
 * - 'all':         keep only text inside [data-dl-unmask] (the merchant put it there on
 *                  purpose) unless inside [data-dl-mask]; buttons/links are masked too
 * - 'marked':      mask only text inside [data-dl-mask]
 * Inputs are not text nodes: their values are masked by maskInputOptions in every mode.
 */
export function maskTextFor(mode: ReplayPrivacy['textMode']): (text: string, element: HTMLElement | null) => string {
  if (mode === 'marked') {
    return (text, element) => {
      try {
        return inside(element, TEXT_FORCE_MASK_SELECTOR) ? star(text) : text;
      } catch {
        return star(text);
      }
    };
  }
  const keep = mode === 'all' ? TEXT_UNMASK_ALL_SELECTOR : TEXT_UNMASK_SELECTOR;
  return (text, element) => {
    try {
      if (inside(element, keep) && !inside(element, TEXT_FORCE_MASK_SELECTOR)) return text;
    } catch {
      // fall through to masking
    }
    return star(text);
  };
}

/** Cut query + fragment; data:/blob: values are left alone (no query to leak, '#' is data). */
export function stripQuery(value: string, srcset = false): string {
  if (/^\s*(data|blob):/i.test(value)) return value;
  if (!srcset) return value.split(/[?#]/)[0];
  // srcset: "url?q 1x, url2?q 2x" — a query runs to the next whitespace.
  return value.replace(/[?#][^\s]*/g, m => (m.endsWith(',') ? ',' : ''));
}

export function needsScrub(p: ReplayPrivacy): boolean {
  return !p.attributes || !p.urlQuery;
}

/** Rewrite one attribute map in place. tagName is unknown for attribute mutations. */
export function scrubAttributes(attrs: Record<string, unknown>, p: ReplayPrivacy, tagName?: string): void {
  for (const name of Object.keys(attrs)) {
    const value = attrs[name];
    if (typeof value !== 'string') continue; // null = removed; objects = style diffs
    const lower = name.toLowerCase();
    if (!p.attributes && (MASKED_ATTRIBUTES.has(lower) || lower.startsWith('data-'))) {
      attrs[name] = '';
      continue;
    }
    // <link> hrefs (fonts, stylesheets rrweb could not inline) keep their query: the
    // replay needs them to render, and they are not page-specific data.
    if (!p.urlQuery && URL_ATTRIBUTES.has(lower) && tagName !== 'link') {
      attrs[name] = stripQuery(value, lower === 'srcset');
    }
  }
}

interface SerializedNode {
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

/** Rewrite a serialized (rrweb-snapshot) node tree in place. */
export function scrubNode(node: unknown, p: ReplayPrivacy): void {
  const stack: SerializedNode[] = [node as SerializedNode];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (n.attributes && typeof n.attributes === 'object') scrubAttributes(n.attributes, p, typeof n.tagName === 'string' ? n.tagName.toLowerCase() : undefined);
    if (Array.isArray(n.childNodes)) for (const c of n.childNodes) stack.push(c);
  }
}

const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;
const SRC_MUTATION = 0;

/** Apply attributes/urlQuery to one rrweb event in place (no-op when both are relaxed). */
export function scrubEvent(event: { type?: number; data?: unknown }, p: ReplayPrivacy): void {
  if (!needsScrub(p) || !event || !event.data) return;
  try {
    if (event.type === EVENT_FULL_SNAPSHOT) {
      scrubNode((event.data as { node?: unknown }).node, p);
    } else if (event.type === EVENT_INCREMENTAL && (event.data as { source?: number }).source === SRC_MUTATION) {
      const data = event.data as { adds?: Array<{ node?: unknown }>; attributes?: Array<{ attributes?: Record<string, unknown> }> };
      if (Array.isArray(data.adds)) for (const add of data.adds) scrubNode(add && add.node, p);
      if (Array.isArray(data.attributes)) {
        for (const m of data.attributes) if (m && m.attributes && typeof m.attributes === 'object') scrubAttributes(m.attributes, p);
      }
    }
  } catch {
    // never throw into rrweb's emit
  }
}
