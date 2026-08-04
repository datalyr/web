// 11-track-links P1-4 — `lyr` must survive a UTM-less landing.
//
// `lyr` is the Datalyr tracking-link tag: the one attribution parameter the
// product itself tells customers to put on a URL, and the key every Track
// reporting surface is built on. It was captured into the attribution object
// but omitted from `hasRealAttribution`, so a bare `?lyr=X` landing (no UTMs,
// no click id) scored FALSE — the direct/internal-nav fallback then replaced
// `current` wholesale with the stored touch, discarding the tag that had just
// been parsed, and neither storeFirstTouch nor storeLastTouch ran, so it never
// persisted either.
//
// It only ever failed for RETURNING visitors: a first-time visitor has no
// stored touch for the fallback to replace `current` with. That is why prod
// measured 3 losses out of 96 tagged landings (3.1%) rather than 96 — and why
// no test caught it. The edge worker's own buildDestination emits exactly this
// URL shape (`?lyr=` alone) when a link defines no UTMs.
//
// iOS (AttributionManager.swift) and React Native persist `lyr`
// unconditionally; these cases pin web to the same behaviour.

export {};

import { AttributionManager } from './attribution';

function withUrl(search: string) {
  window.history.replaceState({}, '', `/landing${search}`);
}

describe('11-track-links P1-4 — lyr persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    withUrl('');
  });

  it('captures lyr from a UTM-less landing URL', () => {
    withUrl('?lyr=AFLNET-7');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.lyr).toBe('AFLNET-7');
  });

  it('persists a UTM-less lyr so a returning visitor still carries it', () => {
    // First visit: bare ?lyr=, nothing else. This is the case that used to
    // store nothing at all.
    withUrl('?lyr=AFLNET-7');
    new AttributionManager({} as never).getAttributionData();

    // Return visit, no params — the direct/internal-nav path.
    withUrl('');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.lyr).toBe('AFLNET-7');
  });

  it('does not discard a just-parsed lyr when a prior touch exists', () => {
    // The exact regression: a stored touch from an earlier UTM'd visit, then a
    // bare ?lyr= landing. The fallback spread used to overwrite `current`
    // (and its fresh lyr) with the stored blob.
    withUrl('?utm_source=newsletter&utm_campaign=launch');
    new AttributionManager({} as never).getAttributionData();

    withUrl('?lyr=AFLNET-7');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.lyr).toBe('AFLNET-7');
  });

  it('still falls back to the stored touch on a genuinely direct visit', () => {
    // Guard against over-correcting: adding lyr to the predicate must not stop
    // an unparameterised pageview from inheriting stored attribution.
    withUrl('?utm_source=newsletter&utm_campaign=launch');
    new AttributionManager({} as never).getAttributionData();

    withUrl('');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.source).toBe('newsletter');
    expect(data.campaign).toBe('launch');
  });
});

describe('lyr carry-forward — repeat social visits must not clobber the link tag', () => {
  function withReferrer(url: string) {
    Object.defineProperty(document, 'referrer', {
      value: url,
      configurable: true,
    });
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    withUrl('');
    withReferrer('');
  });

  afterEach(() => {
    withReferrer('');
  });

  it('keeps the stored lyr when the visitor returns from an organic social referrer', () => {
    // The creator-audience journey: tap the bio link today, come back from an
    // Instagram post next week WITHOUT the link. The organic revisit is a real
    // signal (external referrer → source 'instagram'), and storeLastTouch used
    // to replace the tagged touch wholesale — link credit silently gone.
    withUrl('?lyr=CREATOR-9');
    new AttributionManager({} as never).getAttributionData();

    withUrl('');
    withReferrer('https://www.instagram.com/some.creator/');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.source).toBe('instagram'); // channel still updates
    expect(data.lyr).toBe('CREATOR-9'); // link tag survives

    // And it survives into the touch that got stored, not just this event.
    withUrl('');
    withReferrer('');
    const later = new AttributionManager({} as never).getAttributionData();
    expect(later.lyr).toBe('CREATOR-9');
  });

  it('a NEW lyr on the URL still wins over the stored one', () => {
    withUrl('?lyr=CREATOR-9');
    new AttributionManager({} as never).getAttributionData();

    withUrl('?lyr=CREATOR-22');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.lyr).toBe('CREATOR-22');
  });

  it('a UTM-tagged revisit updates the channel but keeps the link tag', () => {
    withUrl('?lyr=CREATOR-9');
    new AttributionManager({} as never).getAttributionData();

    withUrl('?utm_source=tiktok&utm_campaign=spring');
    const data = new AttributionManager({} as never).getAttributionData();
    expect(data.source).toBe('tiktok');
    expect(data.campaign).toBe('spring');
    expect(data.lyr).toBe('CREATOR-9');
  });
});
