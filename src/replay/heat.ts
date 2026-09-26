/**
 * Heat mode (heatmaps add-on, 1.9.0): the light capture the replay module runs when the
 * page load is allowed heatmaps but not a recording. NO rrweb record(): plain listeners
 * that produce click and scroll-depth records, plus at most one masked DOM snapshot per
 * page load (rrweb-snapshot, the same masking options as the recorder) so the viewer
 * has something to paint the clicks on.
 *
 * Items (the `e` array of a `m:'heat'` envelope; NOT rrweb events):
 *   {t:'attr', source, medium, campaign, content, term, click, landing_path}
 *   {t:'click', ts, path, x_pct, y_pct, y_px, vw, vh, ph, text, sel, kind}
 *   {t:'scroll', ts, path, y_pct_max, ph}
 *   {t:'snap', ts, path, vw, snapshot}
 * `path` is always the origin-less pathname: no query, no fragment.
 *
 * Contract: datalyr-v2 docs/implementation/session-replay-2026-09-26/CHECKLIST.md
 * ("Heat mode" under Interfaces).
 */
import { snapshot } from 'rrweb-snapshot';
import { replayHash } from '../replay-loader';

export const HEAT_TEXT_MAX = 80;
export const HEAT_SEL_MAX = 200;
export const RAGE_CLICKS = 3;
export const RAGE_WINDOW_MS = 1000;
export const RAGE_RADIUS_PX = 30;
export const DEAD_WAIT_MS = 2500;
export const DEAD_SCROLL_SELECT_MS = 100;
export const SNAP_ROLL = 4;             // 1 in 4 page loads (hash of page_load_id)
export const SNAP_MAX_RAW = 900 * 1024; // drop the snap item above this JSON size

export type HeatClickKind = 'click' | 'rage' | 'dead';

export interface HeatClick {
  t: 'click'; ts: number; path: string;
  x_pct: number; y_pct: number; y_px: number;
  vw: number; vh: number; ph: number;
  text: string; sel: string; kind: HeatClickKind;
}
export interface HeatScroll { t: 'scroll'; ts: number; path: string; y_pct_max: number; ph: number }
export interface HeatSnap { t: 'snap'; ts: number; path: string; vw: number; snapshot: unknown }
export type HeatItem = HeatClick | HeatScroll | HeatSnap | ({ t: 'attr' } & Record<string, unknown>);

export interface HeatMasking {
  unmaskSelector: string;
  forceMaskSelector: string;
  maskText(text: string, element: HTMLElement | null): string;
  inputMask: Record<string, boolean>;
}

/** Origin-less pathname of the current page; '/' when unknown. */
export function heatPath(): string {
  try {
    return location.pathname || '/';
  } catch {
    return '/';
  }
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function pageHeight(): number {
  try {
    return Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
  } catch {
    return 0;
  }
}

function pageWidth(): number {
  try {
    return Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0, window.innerWidth || 0);
  } catch {
    return 0;
  }
}

/** tag#id.class path from the element up, nearest part kept, ≤ HEAT_SEL_MAX chars. */
export function heatSelector(el: Element | null): string {
  let out = '';
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += `#${node.id}`;
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) part += `.${cls.join('.')}`;
    const next = out ? `${part} > ${out}` : part;
    if (next.length > HEAT_SEL_MAX) {
      if (!out) out = part.slice(0, HEAT_SEL_MAX);
      break;
    }
    out = next;
    if (part.startsWith('html') || part.startsWith('body')) break;
  }
  return out;
}

/**
 * Text of the clicked control under the recorder's text rules: kept only inside an
 * interactive element (button, a, label, [role=button], summary, [data-dl-unmask]), never
 * inside [data-dl-mask] and never from a form field. Anything masked is dropped (not
 * starred): the click keeps no text at all rather than its length.
 */
export function heatText(target: Element | null, m: HeatMasking): string {
  try {
    const host = target && target.closest(m.unmaskSelector);
    if (!host || target!.closest(m.forceMaskSelector)) return '';
    const parts: string[] = [];
    const walk = document.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest('input, textarea, select, script, style, [contenteditable]')) continue;
      const raw = n.nodeValue || '';
      if (!raw.trim()) continue;
      if (m.maskText(raw, parent) !== raw) continue; // masked under the recorder's rules
      parts.push(raw);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, HEAT_TEXT_MAX);
  } catch {
    return '';
  }
}

interface PendingClick { item: HeatClick; at: number; timer: ReturnType<typeof setTimeout> }

export class HeatCapture {
  private removers: Array<() => void> = [];
  private resumeRemovers: Array<() => void> = [];
  private observer: MutationObserver | null = null;
  private lastMutation = 0;
  private lastScroll = 0;
  private lastSelection = 0;
  private recent: Array<{ at: number; x: number; y: number }> = [];
  private pending = new Set<PendingClick>();
  private path = '';
  private depth = 0;        // max y_pct seen on this path
  private depthSent = -1;   // last y_pct_max emitted for this path
  private lastActive = 0;
  private idle = false;
  private running = false;

  constructor(
    private readonly emit: (item: HeatItem) => void,
    private readonly masking: HeatMasking,
    private readonly idleMs: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.path = heatPath();
    this.depth = 0;
    this.depthSent = -1;
    this.lastActive = Date.now();
    this.idle = false;
    this.attach();
    this.measureDepth();
  }

  /** Emit everything still held (pending dead checks, scroll depth), then detach. */
  stop(emitRemaining: boolean): void {
    if (!this.running) return;
    if (emitRemaining) this.flush();
    else this.dropPending();
    this.running = false;
    this.detach();
    this.detachResume();
  }

  /** Hidden tab / unload / before a chunk goes out urgently. */
  flush(): void {
    if (!this.running) return;
    for (const p of Array.from(this.pending)) this.settle(p, false);
    this.emitScroll();
  }

  /** SPA navigation: close out the old path's depth and start the new one. */
  pathChanged(): void {
    if (!this.running) return;
    const next = heatPath();
    if (next === this.path) return;
    this.emitScroll();
    this.path = next;
    this.depth = 0;
    this.depthSent = -1;
    this.measureDepth();
  }

  /** Called by the recorder's interval: stop listening after idleMs without interaction. */
  tick(now: number): void {
    if (!this.running || this.idle || now - this.lastActive <= this.idleMs) return;
    this.flush();
    this.idle = true;
    this.detach();
    const resume = (): void => {
      if (!this.running || !this.idle) return;
      this.detachResume();
      this.idle = false;
      this.lastActive = Date.now();
      this.attach();
      this.pathChanged();
    };
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']) {
      window.addEventListener(type, resume, true);
      this.resumeRemovers.push(() => window.removeEventListener(type, resume, true));
    }
  }

  isIdle(): boolean {
    return this.idle;
  }

  /**
   * The page load's one masked DOM snapshot: only while the page load's first chunk
   * (q 0) is still open, and only for 1 in SNAP_ROLL page loads (hash of page_load_id).
   */
  snap(pageLoadId: string, firstChunkOpen: boolean): boolean {
    if (!this.running || !firstChunkOpen || !heatSnapRoll(pageLoadId)) return false;
    let node: unknown = null;
    try {
      node = snapshot(document, {
        blockSelector: '[data-dl-block]',
        maskTextSelector: '*',
        maskTextFn: this.masking.maskText,
        maskAllInputs: this.masking.inputMask as unknown as boolean,
        inlineStylesheet: true,
        inlineImages: false,
        recordCanvas: false,
        slimDOM: 'all',
      });
    } catch {
      node = null;
    }
    if (!node) return false;
    const item: HeatSnap = { t: 'snap', ts: Date.now(), path: this.path || heatPath(), vw: window.innerWidth || 0, snapshot: node };
    let size = 0;
    try { size = JSON.stringify(item).length; } catch { return false; }
    if (size > SNAP_MAX_RAW) return false;
    this.emit(item);
    return true;
  }

  private attach(): void {
    const on = (target: EventTarget, type: string, handler: EventListener, capture: boolean): void => {
      target.addEventListener(type, handler, capture ? { capture: true, passive: true } : { passive: true });
      this.removers.push(() => target.removeEventListener(type, handler, capture));
    };
    on(document, 'click', (e: Event) => this.onClick(e as MouseEvent), true);
    on(window, 'scroll', () => { this.lastScroll = Date.now(); this.lastActive = this.lastScroll; this.measureDepth(); }, true);
    on(document, 'selectionchange', () => { this.lastSelection = Date.now(); }, false);
    on(window, 'keydown', () => { this.lastActive = Date.now(); }, true);
    try {
      this.observer = new MutationObserver(() => { this.lastMutation = Date.now(); });
      this.observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch {
      this.observer = null;
    }
  }

  private detach(): void {
    for (const remove of this.removers.splice(0)) {
      try { remove(); } catch { /* best-effort */ }
    }
    try { this.observer?.disconnect(); } catch { /* best-effort */ }
    this.observer = null;
  }

  private detachResume(): void {
    for (const remove of this.resumeRemovers.splice(0)) {
      try { remove(); } catch { /* best-effort */ }
    }
  }

  private measureDepth(): void {
    try {
      const ph = pageHeight();
      if (ph <= 0) return;
      const pct = Math.min(1, ((window.scrollY || window.pageYOffset || 0) + (window.innerHeight || 0)) / ph);
      if (pct > this.depth) this.depth = pct;
    } catch {
      // best-effort
    }
  }

  private emitScroll(): void {
    this.measureDepth();
    const y = round4(this.depth);
    if (y <= 0 || y === this.depthSent) return;
    this.depthSent = y;
    this.emit({ t: 'scroll', ts: Date.now(), path: this.path, y_pct_max: y, ph: pageHeight() });
  }

  private onClick(e: MouseEvent): void {
    try {
      const now = Date.now();
      this.lastActive = now;
      this.pathChanged(); // SPA route changed without a `url` event reaching us
      const raw = e.target as Node | null;
      const target = raw && raw.nodeType === 1 ? raw as Element : raw?.parentElement || null;
      const ph = pageHeight();
      const pageX = typeof e.pageX === 'number' ? e.pageX : 0;
      const pageY = typeof e.pageY === 'number' ? e.pageY : 0;
      const item: HeatClick = {
        t: 'click', ts: now, path: this.path,
        x_pct: round4(Math.min(1, Math.max(0, pageX / Math.max(pageWidth(), 1)))),
        y_pct: ph > 0 ? round4(Math.min(1, Math.max(0, pageY / ph))) : 0,
        y_px: Math.round(pageY),
        vw: window.innerWidth || 0, vh: window.innerHeight || 0, ph,
        text: heatText(target, this.masking),
        sel: heatSelector(target),
        kind: 'click',
      };
      // Rage: ≥ RAGE_CLICKS clicks, each < RAGE_WINDOW_MS after the previous, within RAGE_RADIUS_PX.
      const last = this.recent[this.recent.length - 1];
      if (last && now - last.at < RAGE_WINDOW_MS
        && Math.abs(pageX - last.x) <= RAGE_RADIUS_PX && Math.abs(pageY - last.y) <= RAGE_RADIUS_PX) {
        this.recent.push({ at: now, x: pageX, y: pageY });
      } else {
        this.recent = [{ at: now, x: pageX, y: pageY }];
      }
      if (this.recent.length >= RAGE_CLICKS) {
        item.kind = 'rage';
        this.emit(item);
        return;
      }
      // Dead: nothing happened after the click. Links and inputs are never dead.
      if (!target || target.closest('a, input')) {
        this.emit(item);
        return;
      }
      const pending: PendingClick = { item, at: now, timer: setTimeout(() => this.settle(pending, true), DEAD_WAIT_MS) };
      this.pending.add(pending);
    } catch {
      // never break the host page
    }
  }

  /** Emit a held click; `waited` = the full dead window elapsed, so it may be dead. */
  private settle(p: PendingClick, waited: boolean): void {
    if (!this.pending.delete(p)) return;
    clearTimeout(p.timer);
    const reacted = this.lastMutation >= p.at
      || (this.lastScroll >= p.at && this.lastScroll - p.at <= DEAD_SCROLL_SELECT_MS)
      || (this.lastSelection >= p.at && this.lastSelection - p.at <= DEAD_SCROLL_SELECT_MS);
    if (waited && !reacted) p.item.kind = 'dead';
    this.emit(p.item);
  }

  private dropPending(): void {
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending.clear();
  }
}

/** 1 in SNAP_ROLL page loads, decided by the page_load_id (no stored roll). */
export function heatSnapRoll(pageLoadId: string): boolean {
  return !!pageLoadId && replayHash(`snap:${pageLoadId}`) % SNAP_ROLL === 0;
}
