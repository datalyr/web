/**
 * Session replay recorder: dl.replay.<v>.js (separate Rollup entry, never imported by
 * src/index.ts). Loaded on demand by replay-loader.ts, registers `window.DatalyrReplay`.
 *
 * Capture: rrweb record() with inputs masked and ALL text masked except interactive
 * text (buttons, links, labels, summaries, [role=button], [data-dl-unmask]). rrweb has
 * no "mask all text" switch, so maskTextSelector '*' marks every text node for masking
 * and maskTextFn decides: text inside an exempt element is kept (unless it is inside
 * [data-dl-mask]), everything else becomes '*' per non-space character, which is what
 * rrweb itself would write.
 *
 * Transport: a chunk every 10 s or 256 KB of raw JSON, gzipped whole and POSTed as
 * text/plain to replay.datalyr.com/replay?enc=gzip (a CORS-simple request). When the
 * tab is hidden or the page unloads, the buffer is parked in sessionStorage and sent
 * with one keepalive attempt when it gzips to 16 KB or less; the next page of the same
 * session (same tab) sends whatever is still parked. src/queue.ts is untouched: the
 * event queue's unload beacons keep the whole keepalive quota except those 16 KB.
 *
 * URLs: the page URL in rrweb Meta events and in our `url` Custom event is cut to
 * origin + pathname (no query, no fragment: emails, reset/magic-link tokens, checkout
 * keys). NOT rewritten in v1: URLs inside DOM attributes (a[href], img[src], srcset,
 * form[action], inline style url()) are recorded as rrweb serialises them, query
 * included. Listed for the legal review; the distiller/worker must not surface them.
 */
import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import { gzipSync, strToU8 } from 'fflate';
import { REPLAY_PARK_KEY, replayAttribution } from '../replay-loader';
import type { ReplayContext, ReplayEventKind, ReplayRecorder } from '../replay-loader';
import { generateUUID } from '../utils';

export const FLUSH_INTERVAL_MS = 10_000;
export const FLUSH_RAW_BYTES = 256 * 1024;
export const KEEPALIVE_MAX_BYTES = 16 * 1024;
export const IDLE_PAUSE_MS = 5 * 60 * 1000;
export const MAX_PAGE_MS = 60 * 60 * 1000;
export const PARK_KEY = REPLAY_PARK_KEY;
export const PARK_MAX_BYTES = 1_000_000;
export const ERROR_MAX_CHARS = 300;
export const TEXT_UNMASK_SELECTOR = 'button, a, label, [role=button], summary, [data-dl-unmask]';
const TEXT_FORCE_MASK_SELECTOR = '[data-dl-mask]';
const MUTATION_BUCKET = 100;
const MUTATION_REFILL_PER_S = 10;
const RETRY_MAX = 3;
const RETRY_BASE_MS = 5000;
const RESIZE_THROTTLE_MS = 1000;

// rrweb enums, inlined so the bundle doesn't need @rrweb/types at runtime.
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;
const EVENT_META = 4;
const EVENT_CUSTOM = 5;
const SRC_MUTATION = 0;
const SRC_MOUSE_MOVE = 1;
const SRC_MOUSE_INTERACTION = 2;
const SRC_INPUT = 5;
const SRC_TOUCH_MOVE = 6;
const USER_SOURCES = new Set([SRC_MOUSE_MOVE, SRC_MOUSE_INTERACTION, SRC_INPUT, SRC_TOUCH_MOVE]);

/** origin + pathname only; '' when unparseable (never the raw string). */
export function stripUrl(href: unknown): string {
  if (typeof href !== 'string' || !href) return '';
  try {
    const u = new URL(href, typeof location !== 'undefined' ? location.href : undefined);
    return u.origin + u.pathname;
  } catch {
    return '';
  }
}

interface ParkedChunk { s: string; p: string; q: number; body: string }

/** Keep interactive text readable; mask everything else (see file header). */
export function maskText(text: string, element: HTMLElement | null): string {
  try {
    if (element && element.closest && element.closest(TEXT_UNMASK_SELECTOR) && !element.closest(TEXT_FORCE_MASK_SELECTOR)) {
      return text;
    }
  } catch {
    // fall through to masking
  }
  return text.replace(/[\S]/g, '*');
}

function isIOS(): boolean {
  try {
    const ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  } catch {
    return false;
  }
}

function byteLength(s: string): number {
  return strToU8(s).length;
}

async function gzip(body: string): Promise<Uint8Array> {
  if (typeof CompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function') {
    try {
      const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // fall back to fflate
    }
  }
  return gzipSync(strToU8(body));
}

function readParked(): ParkedChunk[] {
  try {
    const raw = sessionStorage.getItem(PARK_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeParked(chunks: ParkedChunk[]): void {
  try {
    // Newest win when over the cap: the tail of a session is what is otherwise lost.
    let total = 0;
    const kept: ParkedChunk[] = [];
    for (let i = chunks.length - 1; i >= 0; i--) {
      total += chunks[i].body.length;
      if (total > PARK_MAX_BYTES) break;
      kept.unshift(chunks[i]);
    }
    if (kept.length) sessionStorage.setItem(PARK_KEY, JSON.stringify(kept));
    else sessionStorage.removeItem(PARK_KEY);
  } catch {
    // storage full or blocked: the chunk is lost, recording goes on
  }
}

export class Recorder implements ReplayRecorder {
  // Build-time literal (rollup injectSdkVersion); scripts/check-bundle.js checks it.
  readonly replay_version = '__SDK_VERSION__';
  private ctx: ReplayContext | null = null;
  private stopRecord: (() => void) | undefined;
  private recording = false;
  private capped = false; // hit MAX_PAGE_MS: no restart on this page
  private sid = '';
  private pageLoadId = '';
  private seq = 0;
  private buf: eventWithTime[] = [];
  private bufBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private lastActive = 0;
  private idle = false;
  private buckets = new Map<number, { tokens: number; at: number }>();
  private removers: Array<() => void> = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped by stop(true) (a gate closed: consent withdrawn, opt-out, reset...). Every
   * send and retry carries the generation of its chunk and aborts once it changed, so
   * nothing recorded before the withdrawal leaves after it.
   */
  private generation = 0;

  isRecording(): boolean {
    return this.recording;
  }

  start(ctx: ReplayContext): void {
    this.ctx = ctx;
    if (this.recording || this.capped) return;
    this.sid = ctx.getSessionId();
    this.pageLoadId = generateUUID();
    this.seq = 0;
    this.buf = [];
    this.bufBytes = 0;
    this.startedAt = Date.now();
    this.lastActive = this.startedAt;
    this.idle = false;
    this.buckets.clear();
    this.recording = true;
    this.sendParked();
    try {
      this.stopRecord = record({
        emit: (event, isCheckout) => this.onEmit(event as eventWithTime, !!isCheckout),
        // NOT maskAllInputs: rrweb expands that to a fixed list of input TYPES, which
        // leaves type=hidden (and any unlisted type) in clear. The tag keys mask every
        // input/textarea/select value whatever its type (rrweb maskInputValue checks
        // maskInputOptions[tagName] first). submit/button values stay: rrweb never masks them.
        maskAllInputs: false,
        maskInputOptions: { input: true, textarea: true, select: true, password: true } as Record<string, boolean>,
        maskTextSelector: '*',
        maskTextFn: maskText,
        blockSelector: '[data-dl-block]',
        slimDOMOptions: 'all',
        inlineStylesheet: true,
        inlineImages: false,
        collectFonts: false,
        recordCanvas: false,
        recordCrossOriginIframes: false,
        sampling: { mousemove: !isIOS(), scroll: 150, input: 'last' },
        checkoutEveryNms: 300_000,
        errorHandler: () => true, // swallow: never throw into the host page
      });
    } catch {
      this.stopRecord = undefined;
    }
    if (!this.stopRecord) {
      this.recording = false;
      return;
    }
    // record() emitted Meta + FullSnapshot synchronously; the attr marker follows them.
    this.attr();
    this.listen();
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.pageHeight();
  }

  stop(discard: boolean): void {
    if (discard) {
      this.generation++;
      writeParked([]);
    }
    if (!this.recording) return;
    if (discard) {
      this.buf = [];
      this.bufBytes = 0;
    } else {
      this.flush();
    }
    this.teardown();
  }

  event(kind: ReplayEventKind, payload: Record<string, unknown>): void {
    if (!this.recording) return;
    try {
      record.addCustomEvent('dl', { k: kind, ...payload });
    } catch {
      // best-effort
    }
  }

  sessionChanged(sessionId: string): void {
    if (!this.recording || !sessionId || sessionId === this.sid) return;
    this.flush();
    this.sid = sessionId;
    // Every session must start playable on its own.
    setTimeout(() => { this.fullSnapshot(); this.attr(); }, 0);
  }

  /** Send the buffer now (normal path: async gzip, fetch with retries). */
  flush(): void {
    const chunk = this.drain();
    if (chunk) void this.send(chunk.body, 0, this.generation);
  }

  /**
   * Hidden tab / unload: park the buffer for the next page, then try once to send it.
   * keepalive only when the gzip fits in KEEPALIVE_MAX_BYTES; a hidden (not unloading)
   * page may also try a plain fetch. A successful send unparks the chunk.
   */
  flushUrgent(terminal: boolean): void {
    const chunk = this.drain();
    if (!chunk) return;
    const parked = readParked();
    parked.push(chunk);
    writeParked(parked);
    let gz: Uint8Array;
    try {
      gz = gzipSync(strToU8(chunk.body));
    } catch {
      return;
    }
    const keepalive = gz.length <= KEEPALIVE_MAX_BYTES;
    if (!keepalive && terminal) return; // stays parked for the next page
    const gen = this.generation;
    this.post(gz, keepalive, false, gen)
      .then(ok => { if (ok) this.unpark(chunk.p, chunk.q); })
      .catch(() => undefined);
  }

  private onEmit(event: eventWithTime, isCheckout: boolean): void {
    if (!this.recording) return;
    const now = Date.now();
    if (now - this.startedAt > MAX_PAGE_MS) {
      this.capped = true;
      this.stop(false);
      return;
    }
    if (event.type === EVENT_META) {
      const data = event.data as { href?: unknown };
      if (data && 'href' in data) data.href = stripUrl(data.href);
    } else if (event.type === EVENT_CUSTOM) {
      const data = event.data as { tag?: unknown; payload?: { k?: unknown; href?: unknown } };
      if (data && data.tag === 'dl' && data.payload && data.payload.k === 'url' && 'href' in data.payload) {
        data.payload.href = stripUrl(data.payload.href);
      } else if (data && data.tag === 'dl' && data.payload && data.payload.k === 'attr') {
        data.payload = { k: 'attr', ...replayAttribution(data.payload as Record<string, unknown>) };
      }
    }
    if (event.type === EVENT_INCREMENTAL) {
      const source = (event.data as { source?: number }).source ?? -1;
      if (USER_SOURCES.has(source)) {
        this.lastActive = now;
        if (this.idle) {
          this.idle = false;
          setTimeout(() => this.fullSnapshot(), 0);
        }
      } else if (now - this.lastActive > IDLE_PAUSE_MS) {
        this.idle = true;
      }
      if (this.idle) return;
      if (source === SRC_MUTATION && !this.throttle(event, now)) return;
    } else if (this.idle && isCheckout && (event.type === EVENT_FULL_SNAPSHOT || event.type === EVENT_META)) {
      return; // no periodic snapshots of an idle tab; one is taken when activity resumes
    }
    this.push(event);
  }

  private push(event: eventWithTime): void {
    let size = 0;
    try {
      size = JSON.stringify(event).length;
    } catch {
      return;
    }
    this.buf.push(event);
    this.bufBytes += size;
    if (this.bufBytes >= FLUSH_RAW_BYTES) this.flush();
  }

  /**
   * PostHog-style per-node token bucket (100, refill 10/s) on attribute and text
   * mutations, so a widget that rewrites one node in a loop can't flood the recording.
   * Returns false when nothing of the event is left.
   */
  private throttle(event: eventWithTime, now: number): boolean {
    const data = event.data as {
      adds?: unknown[]; removes?: unknown[];
      texts?: Array<{ id: number }>; attributes?: Array<{ id: number }>;
    };
    const allow = (entry: { id: number }): boolean => {
      const b = this.buckets.get(entry.id) || { tokens: MUTATION_BUCKET, at: now };
      b.tokens = Math.min(MUTATION_BUCKET, b.tokens + ((now - b.at) / 1000) * MUTATION_REFILL_PER_S);
      b.at = now;
      this.buckets.set(entry.id, b);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    };
    if (Array.isArray(data.attributes)) data.attributes = data.attributes.filter(allow);
    if (Array.isArray(data.texts)) data.texts = data.texts.filter(allow);
    return !!(data.adds?.length || data.removes?.length || data.texts?.length || data.attributes?.length);
  }

  private drain(): ParkedChunk | null {
    if (!this.ctx || !this.buf.length) return null;
    const events = this.buf;
    this.buf = [];
    this.bufBytes = 0;
    let e: string;
    try {
      e = JSON.stringify(events);
    } catch {
      return null;
    }
    const q = this.seq++;
    let v = '';
    try { v = this.ctx.getVisitorId(); } catch { /* keep empty */ }
    // Envelope: see datalyr-v2 docs/implementation/session-replay-2026-09-26/CHECKLIST.md "Interfaces".
    const body = `{"w":${JSON.stringify(this.ctx.workspaceId)},"s":${JSON.stringify(this.sid)},"v":${JSON.stringify(v)},`
      + `"p":${JSON.stringify(this.pageLoadId)},"q":${q},"sv":${JSON.stringify(this.ctx.sdkVersion)},`
      + `"rb":${byteLength(e)},"e":${e}}`;
    return { s: this.sid, p: this.pageLoadId, q, body };
  }

  private async send(body: string, attempt: number, gen: number): Promise<void> {
    if (gen !== this.generation) return;
    let gz: Uint8Array;
    try {
      gz = await gzip(body);
    } catch {
      return;
    }
    const ok = await this.post(gz, false, true, gen);
    if (ok !== null || attempt >= RETRY_MAX || gen !== this.generation) return;
    setTimeout(() => { void this.send(body, attempt + 1, gen); }, RETRY_BASE_MS * Math.pow(2, attempt));
  }

  /**
   * POST one gzipped chunk. Resolves true on 2xx, false on a refusal that must not be
   * retried (4xx), and null on a network error / 5xx when `retryable` is set.
   */
  private async post(gz: Uint8Array, keepalive: boolean, retryable: boolean, gen: number): Promise<boolean | null> {
    if (!this.ctx || typeof fetch !== 'function' || gen !== this.generation) return false;
    try {
      const res = await fetch(`${this.ctx.endpoint}?enc=gzip`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive,
        headers: { 'Content-Type': 'text/plain' },
        body: gz as unknown as BodyInit,
      });
      if (res.ok) return true;
      return retryable && res.status >= 500 ? null : false;
    } catch {
      return retryable ? null : false;
    }
  }

  /** Send what a previous page of THIS session parked; drop anything else. */
  private sendParked(): void {
    const parked = readParked();
    if (!parked.length) return;
    writeParked([]);
    for (const chunk of parked) {
      if (chunk && chunk.s === this.sid && typeof chunk.body === 'string') void this.send(chunk.body, 0, this.generation);
    }
  }

  private unpark(p: string, q: number): void {
    writeParked(readParked().filter(c => !(c.p === p && c.q === q)));
  }

  /** Landing attribution marker (URLs carry no query string, so distill reads this). */
  private attr(): void {
    let raw: Record<string, unknown> | null = null;
    try { raw = this.ctx?.getAttribution ? this.ctx.getAttribution() as unknown as Record<string, unknown> : null; } catch { raw = null; }
    this.event('attr', { ...replayAttribution(raw) });
  }

  private fullSnapshot(): void {
    if (!this.recording) return;
    try { record.takeFullSnapshot(true); } catch { /* best-effort */ }
  }

  private pageHeight(): void {
    try {
      const h = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
      this.event('ph', { h });
    } catch {
      // best-effort
    }
  }

  private listen(): void {
    const on = (target: EventTarget, type: string, handler: EventListener): void => {
      target.addEventListener(type, handler);
      this.removers.push(() => target.removeEventListener(type, handler));
    };
    on(document, 'visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      this.event('vis', { hidden });
      if (hidden) this.flushUrgent(false);
    });
    const unload = (): void => this.flushUrgent(true);
    on(window, 'pagehide', unload);
    on(window, 'beforeunload', unload);
    on(window, 'error', (e: Event) => {
      const ev = e as ErrorEvent;
      this.error(ev.message || (ev.error && (ev.error as Error).message) || 'error');
    });
    on(window, 'unhandledrejection', (e: Event) => {
      const reason = (e as PromiseRejectionEvent).reason;
      this.error(reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : String(reason));
    });
    on(window, 'resize', () => {
      if (this.resizeTimer) return;
      this.resizeTimer = setTimeout(() => { this.resizeTimer = null; this.pageHeight(); }, RESIZE_THROTTLE_MS);
    });
    if (document.readyState !== 'complete') on(window, 'load', () => this.pageHeight());
  }

  private error(message: string): void {
    this.event('err', { msg: String(message).slice(0, ERROR_MAX_CHARS) });
  }

  private teardown(): void {
    this.recording = false;
    try { this.stopRecord?.(); } catch { /* best-effort */ }
    this.stopRecord = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    for (const remove of this.removers.splice(0)) {
      try { remove(); } catch { /* best-effort */ }
    }
  }
}

if (typeof window !== 'undefined' && !(window as any).DatalyrReplay) {
  (window as any).DatalyrReplay = new Recorder();
}
