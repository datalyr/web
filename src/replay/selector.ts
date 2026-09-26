/**
 * Click fidelity (1.9.2): the shared click selector, target resolution, position class
 * and element box used by heat items AND the replay-mode `clk` companion event. The
 * worker (distill / heat rollups) is built against exactly this algorithm; change both
 * together. Contract: heatmaps-backend-handoff.md §1–§3.
 */

export const SEL_MAX = 200;
export const SEL_LEVELS = 6;
export const SEL_CLASSES = 3;
export const INTERACTIVE_LEVELS = 3;
const INTERACTIVE = 'button, a, [role=button], input, label, summary';

/** CSS.escape when available, else the minimal CSSOM serialize-an-identifier. */
export function cssEscape(value: string): string {
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  } catch { /* fall through */ }
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    if (code === 0) { out += '�'; continue; }
    if ((code >= 1 && code <= 31) || code === 127
      || (i === 0 && code >= 48 && code <= 57)
      || (i === 1 && code >= 48 && code <= 57 && value.charCodeAt(0) === 45)) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 0 && value.length === 1 && code === 45) { out += `\\${ch}`; continue; }
    if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += ch;
      continue;
    }
    out += `\\${ch}`;
  }
  return out;
}

/** Build-tool / CSS-in-JS generated class names: never stable across deploys. */
export function isGeneratedClass(cls: string): boolean {
  if (/^(css-|sc-|jsx-)/.test(cls)) return true;
  return cls.split(/[-_]/).some(seg => /^\d{5,}$/.test(seg));
}

function idIsUnique(el: Element): boolean {
  try {
    return (el.ownerDocument || document).querySelectorAll(`#${cssEscape(el.id)}`).length === 1;
  } catch {
    return false;
  }
}

/** One level's token; `anchor` = unique id (stop walking). */
function levelToken(el: Element, classLimit = SEL_CLASSES): { token: string; anchor: boolean } {
  const tag = el.tagName.toLowerCase();
  if (el.id && idIsUnique(el)) return { token: `#${cssEscape(el.id)}`, anchor: true };
  let token = tag;
  const raw = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
  const classes = raw.trim().split(/\s+/).filter(c => c && !isGeneratedClass(c)).slice(0, classLimit);
  for (const c of classes) token += `.${cssEscape(c)}`;
  const parent = el.parentElement;
  if (parent) {
    let n = 0;
    let index = 0;
    for (let sib = parent.firstElementChild; sib; sib = sib.nextElementSibling) {
      if (sib.tagName === el.tagName) {
        n++;
        if (sib === el) index = n;
      }
    }
    if (n > 1) token += `:nth-of-type(${index})`;
  }
  return { token, anchor: false };
}

/**
 * Selector from `el` up to body (exclusive), ≤ SEL_LEVELS levels, stopping at a unique
 * id. Over SEL_MAX chars: whole levels dropped from the root side, never mid-token.
 */
export function dlSelector(el: Element | null): string {
  try {
    if (!el || el.nodeType !== 1) return '';
    const tokens: string[] = [];
    for (let node: Element | null = el; node && tokens.length < SEL_LEVELS; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      const { token, anchor } = levelToken(node);
      tokens.unshift(token);
      if (anchor) break;
    }
    if (!tokens.length) return el.tagName.toLowerCase();
    while (tokens.length > 1 && tokens.join(' > ').length > SEL_MAX) tokens.shift();
    if (tokens[0].length > SEL_MAX) {
      // A single level still too long: fewer classes, whole tokens only.
      for (let k = SEL_CLASSES - 1; k >= 0; k--) {
        tokens[0] = levelToken(el, k).token;
        if (tokens[0].length <= SEL_MAX) break;
      }
      if (tokens[0].length > SEL_MAX) return '';
    }
    return tokens.join(' > ');
  } catch {
    return '';
  }
}

/** Nearest interactive ancestor (itself included) within INTERACTIVE_LEVELS, else el. */
export function clickTarget(el: Element | null): Element | null {
  let node = el;
  for (let i = 0; node && i <= INTERACTIVE_LEVELS; i++, node = node.parentElement) {
    try { if (node.matches(INTERACTIVE)) return node; } catch { return el; }
  }
  return el;
}

export type ClickPos = 'fixed' | 'page';

/** 'fixed' when el or an ancestor is position:fixed, or sticky and currently stuck. */
export function clickPos(el: Element | null): ClickPos {
  try {
    const vh = window.innerHeight || 0;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.position === 'fixed') return 'fixed';
      if (cs.position === 'sticky') {
        const rect = node.getBoundingClientRect();
        const top = parseFloat(cs.top);
        const bottom = parseFloat(cs.bottom);
        if (!isNaN(top) && rect.top <= top + 1) return 'fixed';
        if (!isNaN(bottom) && vh > 0 && rect.bottom >= vh - bottom - 1) return 'fixed';
      }
    }
  } catch { /* page */ }
  return 'page';
}

export interface ClickFacts {
  target: Element | null;
  sel: string; pos: ClickPos;
  bx: number; by: number; bw: number; bh: number;
  ox: number; oy: number;
  clientX: number; clientY: number;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Everything about a click the heat item and the `clk` companion share. */
export function clickFacts(e: MouseEvent): ClickFacts {
  const raw = e.target as Node | null;
  const hit = raw && raw.nodeType === 1 ? raw as Element : raw?.parentElement || null;
  const target = clickTarget(hit);
  const sx = window.scrollX || window.pageXOffset || 0;
  const sy = window.scrollY || window.pageYOffset || 0;
  const clientX = typeof e.clientX === 'number' && (e.clientX || !e.pageX) ? e.clientX : (e.pageX || 0) - sx;
  const clientY = typeof e.clientY === 'number' && (e.clientY || !e.pageY) ? e.clientY : (e.pageY || 0) - sy;
  const pos = clickPos(target);
  let bx = 0; let by = 0; let bw = 0; let bh = 0; let ox = 0; let oy = 0;
  try {
    if (target) {
      const r = target.getBoundingClientRect();
      const addX = pos === 'fixed' ? 0 : sx;
      const addY = pos === 'fixed' ? 0 : sy;
      bx = Math.round(r.left + addX);
      by = Math.round(r.top + addY);
      bw = Math.round(r.width);
      bh = Math.round(r.height);
      ox = r.width > 0 ? round4(clamp01((clientX - r.left) / r.width)) : 0;
      oy = r.height > 0 ? round4(clamp01((clientY - r.top) / r.height)) : 0;
    }
  } catch { /* zeros */ }
  return { target, sel: dlSelector(target), pos, bx, by, bw, bh, ox, oy, clientX, clientY };
}
