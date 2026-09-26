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
 *
 * Heat mode (1.9.0, heatmaps add-on): when replay is not allowed for this page load but
 * the dashboard's `heatmaps: { enabled, sampleRate }` is (same gates, own sample rate on
 * the same session-id hash), the SAME module is loaded and started with mode 'heat': no
 * rrweb recording, only click/scroll records (see src/replay/heat.ts). Replay wins when
 * both are allowed: heatmap rows are derived server-side from the recording.
 */
import type { HeatmapsRemoteConfig, ReplayRemoteConfig } from './types';

export const REPLAY_MODULE_BASE = 'https://track.datalyr.com';
export const REPLAY_ENDPOINT = 'https://replay.datalyr.com/replay';
export const REPLAY_GLOBAL = 'DatalyrReplay';
export const REPLAY_PARK_KEY = 'dl_replay_park'; // sessionStorage; written by the recorder

/** 'replay' = full rrweb recording; 'heat' = heatmaps-only light capture. */
export type ReplayMode = 'replay' | 'heat';

export type ReplayEventKind = 'track' | 'url' | 'vis' | 'ph' | 'err' | 'attr';

/** Click-id kinds the attr marker may name. The click id VALUE is never recorded. */
export const REPLAY_CLICK_KINDS = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'sclid'] as const;
export type ReplayClickKind = typeof REPLAY_CLICK_KINDS[number];
export const REPLAY_ATTR_MAX_CHARS = 100;

/**
 * Landing attribution for the recording (the recorder strips query strings from URLs, so
 * distill cannot read UTMs from the href). Every field is present; null when unknown.
 */
export interface ReplayAttribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  click: ReplayClickKind | null;
  landing_path: string | null;
}

function attrStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, REPLAY_ATTR_MAX_CHARS) : null;
}

/**
 * Shape any attribution-like record into the attr marker payload. Allowlist only: no
 * click id value, no full URL, strings capped. Used by the SDK getter and again by the
 * recorder, so an older or newer counterpart cannot leak extra fields.
 */
export function replayAttribution(a: Record<string, unknown> | null | undefined): ReplayAttribution {
  const src = a && typeof a === 'object' ? a : {};
  const click = typeof src.clickIdType === 'string' && (REPLAY_CLICK_KINDS as readonly string[]).includes(src.clickIdType)
    ? src.clickIdType as ReplayClickKind
    : typeof src.click === 'string' && (REPLAY_CLICK_KINDS as readonly string[]).includes(src.click)
      ? src.click as ReplayClickKind
      : null;
  let path = attrStr(src.landing_path ?? src.landingPath);
  if (path) path = path.split(/[?#]/)[0] || null;
  return {
    source: attrStr(src.source),
    medium: attrStr(src.medium),
    campaign: attrStr(src.campaign),
    content: attrStr(src.content),
    term: attrStr(src.term),
    click,
    landing_path: path,
  };
}

/** What the recorder needs from the SDK. Getters so it always reads the live value. */
export interface ReplayContext {
  workspaceId: string;
  sdkVersion: string;
  endpoint: string;
  getSessionId(): string;
  getVisitorId(): string;
  /** Last-touch attribution for the attr marker. Optional: an older dl.js has none. */
  getAttribution?(): ReplayAttribution;
}

/** The surface dl.replay.<v>.js registers on window.DatalyrReplay. */
export interface ReplayRecorder {
  /** mode defaults to 'replay' (a 1.8.x module takes one argument). */
  start(ctx: ReplayContext, mode?: ReplayMode): void;
  /** Modes this module supports; a module without it (1.8.x) only records replay. */
  modes?: ReadonlyArray<ReplayMode>;
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
  heatmaps?: HeatmapsRemoteConfig | null;         // the dashboard value, never the init() value
  heatmapsDisabledAtInit?: boolean;               // init({ heatmaps: false })
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

function privacyGatesOpen(g: ReplayGateInputs): boolean {
  return g.tracking && g.marketing && !g.strict && !g.doNotTrack && !g.globalPrivacyControl;
}

export function replayAllowed(g: ReplayGateInputs): boolean {
  return !!g.remote && g.remote.enabled === true
    && !g.disabledAtInit
    && privacyGatesOpen(g)
    && replaySampleHit(g.sessionId, g.remote.sampleRate);
}

/** Heat mode: the same gates as replay, the heatmaps key and its own sample rate. */
export function heatmapsAllowed(g: ReplayGateInputs): boolean {
  return !!g.heatmaps && g.heatmaps.enabled === true
    && !g.heatmapsDisabledAtInit
    && privacyGatesOpen(g)
    && replaySampleHit(g.sessionId, g.heatmaps.sampleRate);
}

/** What this page load captures: replay wins over heat; null = nothing. */
export function replayMode(g: ReplayGateInputs): ReplayMode | null {
  if (replayAllowed(g)) return 'replay';
  if (heatmapsAllowed(g)) return 'heat';
  return null;
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
  private mode: ReplayMode | null = null;
  private running: ReplayMode | null = null; // mode the recorder was started in

  constructor(private readonly context: ReplayContext) {}

  /**
   * Start (loading the module once) in `mode`; stop and discard when null. A mode change
   * on the same page (dashboard flip) discards the current capture and restarts.
   */
  sync(mode: ReplayMode | null, moduleVersion: unknown): void {
    if (mode && this.running && mode !== this.running) this.stop(true);
    this.mode = mode;
    if (!mode) {
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
    this.running = null;
    try { this.recorder.stop(discard); } catch { /* best-effort */ }
  }

  private start(): void {
    const recorder = this.recorder;
    const mode = this.mode;
    if (!recorder || !mode) return;
    // A 1.8.x module (pinned replay.v) would treat any start() as a full recording.
    if (mode !== 'replay' && !(Array.isArray(recorder.modes) && recorder.modes.includes(mode))) return;
    try {
      recorder.start(this.context, mode);
      this.running = mode;
    } catch { /* best-effort */ }
  }

  private registered(): ReplayRecorder | null {
    const r = typeof window !== 'undefined' ? (window as any)[REPLAY_GLOBAL] : null;
    return r && typeof r.start === 'function' ? r as ReplayRecorder : null;
  }
}
