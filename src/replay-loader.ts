/**
 * Session replay loader (part of dl.js; the recorder itself is NOT).
 *
 * Replay is billed per recorded session, so it is enabled from the dashboard only:
 * the `/container-scripts` config carries `replay: { enabled, sampleRate, v }`. An
 * init() `replay: false` can switch it off; nothing passed to init() can switch it on.
 *
 * When every gate is open this injects `https://track.datalyr.com/dl.replay.<v>.js`
 * once. That module (src/replay/recorder.ts, a separate Rollup entry) carries rrweb
 * and registers itself as `window.DatalyrReplay`; this file only decides whether it
 * may run and forwards our own events to it. Keep this file small: it ships to every
 * visitor of every site, recorded or not.
 *
 * Sampling hashes the session id, so every page load of a session agrees without
 * persisting a roll anywhere.
 */
import type { ReplayRemoteConfig } from './types';

export const REPLAY_MODULE_BASE = 'https://track.datalyr.com';
export const REPLAY_ENDPOINT = 'https://replay.datalyr.com/replay';
export const REPLAY_GLOBAL = 'DatalyrReplay';
export const REPLAY_PARK_KEY = 'dl_replay_park'; // sessionStorage; written by the recorder

export type ReplayEventKind = 'track' | 'url' | 'vis' | 'ph' | 'err';

/** What the recorder needs from the SDK. Getters so it always reads the live value. */
export interface ReplayContext {
  workspaceId: string;
  sdkVersion: string;
  endpoint: string;
  getSessionId(): string;
  getVisitorId(): string;
}

/** The surface dl.replay.<v>.js registers on window.DatalyrReplay. */
export interface ReplayRecorder {
  start(ctx: ReplayContext): void;
  /** discard=true drops the unsent buffer and anything parked for the next page. */
  stop(discard: boolean): void;
  event(kind: ReplayEventKind, payload: Record<string, unknown>): void;
  /** Flush under the old session id, then continue under the new one with a full snapshot. */
  sessionChanged(sessionId: string): void;
  isRecording(): boolean;
}

export interface ReplayGateInputs {
  remote: ReplayRemoteConfig | null | undefined; // the dashboard value, never the init() value
  disabledAtInit: boolean;                        // init({ replay: false })
  tracking: boolean;                              // shouldTrack(): opt-out, analytics consent, Shopify analytics
  marketing: boolean;                             // consentAllowsMarketing(): setConsent + Shopify marketing
  strict: boolean;                                // privacyMode === 'strict'
  doNotTrack: boolean;                            // honored for replay whatever respectDoNotTrack says
  globalPrivacyControl: boolean;                  // honored for replay whatever respectGlobalPrivacyControl says
  sessionId: string;
}

/** 32-bit FNV-1a. Stable across loads and browsers; not a security boundary. */
export function replayHash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** True when this session falls inside the sample. Missing rate = every session. */
export function replaySampleHit(sessionId: string, sampleRate: unknown): boolean {
  if (!sessionId) return false;
  const rate = sampleRate === undefined || sampleRate === null
    ? 1
    : (typeof sampleRate === 'number' && Number.isFinite(sampleRate) ? Math.min(1, Math.max(0, sampleRate)) : 0);
  return replayHash(sessionId) % 10000 < Math.round(rate * 10000);
}

export function replayAllowed(g: ReplayGateInputs): boolean {
  return !!g.remote && g.remote.enabled === true
    && !g.disabledAtInit
    && g.tracking && g.marketing && !g.strict
    && !g.doNotTrack && !g.globalPrivacyControl
    && replaySampleHit(g.sessionId, g.remote.sampleRate);
}

/** Versioned, immutable module URL. An odd `v` falls back to the SDK's own version. */
export function replayModuleUrl(v: unknown, sdkVersion: string): string {
  const version = typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/i.test(v) ? v : sdkVersion;
  return `${REPLAY_MODULE_BASE}/dl.replay.${version}.js`;
}

const PRODUCT_ID_KEYS = ['product_id', 'product_ids', 'content_ids', 'variant_id', 'sku'];

/**
 * What of a track() call goes into the recording: the event name and, when present,
 * value/currency/product ids. Never the rest of the properties (they can carry PII).
 */
export function replayTrackPayload(name: string, props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { name: String(name).slice(0, 100) };
  if (!props || typeof props !== 'object') return out;
  const value = [props.value, props.revenue].find(v => typeof v === 'number' && Number.isFinite(v));
  if (value !== undefined) out.value = value;
  if (typeof props.currency === 'string') out.currency = props.currency.slice(0, 8);
  for (const key of PRODUCT_ID_KEYS) {
    const v = props[key];
    if (typeof v === 'string' || typeof v === 'number') out[key] = String(v).slice(0, 64);
    else if (Array.isArray(v)) out[key] = v.slice(0, 20).filter(x => typeof x === 'string' || typeof x === 'number').map(x => String(x).slice(0, 64));
  }
  return out;
}

export class ReplayLoader {
  private recorder: ReplayRecorder | null = null;
  private injected = false;
  private wanted = false;

  constructor(private readonly context: ReplayContext) {}

  /** Start (loading the module once) when allowed; stop and discard when not. */
  sync(allowed: boolean, moduleVersion: unknown): void {
    if (!allowed) {
      this.wanted = false;
      this.stop(true);
      try { sessionStorage.removeItem(REPLAY_PARK_KEY); } catch { /* blocked storage */ }
      return;
    }
    this.wanted = true;
    const recorder = this.recorder || this.registered();
    if (recorder) {
      this.recorder = recorder;
      this.start();
      return;
    }
    if (this.injected || typeof document === 'undefined') return;
    this.injected = true; // once per page, even if it fails to load
    try {
      const script = document.createElement('script');
      script.src = replayModuleUrl(moduleVersion, this.context.sdkVersion);
      script.async = true;
      // No crossOrigin: track.datalyr.com sends no Access-Control-Allow-Origin, and a
      // crossorigin script without it fails to load.
      script.onload = () => {
        this.recorder = this.registered();
        if (this.wanted) this.start();
      };
      // Blocked (CSP, ad blocker, 404): record nothing, never retry on this page.
      script.onerror = () => { this.recorder = null; };
      (document.head || document.documentElement).appendChild(script);
    } catch {
      // best-effort: replay must never break the page or tracking
    }
  }

  event(kind: ReplayEventKind, payload: Record<string, unknown>): void {
    if (!this.wanted || !this.recorder) return;
    try { this.recorder.event(kind, payload); } catch { /* best-effort */ }
  }

  sessionChanged(sessionId: string): void {
    if (!this.recorder) return;
    try { this.recorder.sessionChanged(sessionId); } catch { /* best-effort */ }
  }

  stop(discard: boolean): void {
    if (!this.recorder) return;
    try { this.recorder.stop(discard); } catch { /* best-effort */ }
  }

  private start(): void {
    try { this.recorder?.start(this.context); } catch { /* best-effort */ }
  }

  private registered(): ReplayRecorder | null {
    const r = typeof window !== 'undefined' ? (window as any)[REPLAY_GLOBAL] : null;
    return r && typeof r.start === 'function' ? r as ReplayRecorder : null;
  }
}
