/**
 * Destination pixels module: dl.pixels.<v>.js (separate Rollup entry, never
 * imported by src/index.ts). Injected on demand by src/destination-pixels.ts
 * when /container-scripts configures one of its platforms; registers
 * `window.DatalyrPixels`.
 *
 * One module for every ad platform whose browser pixel runs next to a DATALYR
 * server sender, so a site pays for them only when it has one: AppLovin today;
 * the X Pixel and the LinkedIn Insight Tag are meant to be added here as
 * further `platforms` entries with the same load / track shape.
 */
import { PIXELS_API, PIXELS_GLOBAL } from '../destination-pixels';
import type { DestinationPixelsModule, PixelEvent, PixelLoadContext, PixelLoadStatus } from '../destination-pixels';
import { AppLovinPixel } from './applovin';

interface Platform {
  load(config: any, ctx: PixelLoadContext): Promise<PixelLoadStatus>;
  track(config: any, event: PixelEvent, ctx: { allowed: () => boolean }): Promise<boolean>;
}

export function createPixelsModule(): DestinationPixelsModule & { platforms: Record<string, Platform>; pixels_version: string } {
  const platforms: Record<string, Platform> = { applovin: new AppLovinPixel() };
  return {
    api: PIXELS_API,
    version: '__SDK_VERSION__',
    pixels_version: '__SDK_VERSION__', // checked by scripts/check-bundle.js
    platforms,
    async load(platform, config, ctx) {
      const target = Object.prototype.hasOwnProperty.call(platforms, platform) ? platforms[platform] : null;
      if (!target) return 'blocked';
      try { return await target.load(config, ctx); } catch { return 'blocked'; }
    },
    async track(platform, config, event, ctx) {
      const target = Object.prototype.hasOwnProperty.call(platforms, platform) ? platforms[platform] : null;
      if (!target) return false;
      try { return await target.track(config, event, ctx); } catch { return false; }
    },
  };
}

if (typeof window !== 'undefined' && !(window as any)[PIXELS_GLOBAL]) {
  (window as any)[PIXELS_GLOBAL] = createPixelsModule();
}
