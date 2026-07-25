// WEB-28 — the web SDK must capture OpenAI Ads' `oppref`.
//
// It was present in iOS (AttributionManager.swift) and React Native
// (src/attribution.ts) since launch but absent from the web SDK and from the
// shipped infra/tracking/dl.js, so every OpenAI Ads *web* conversion delivered
// with attribution_type: none. The postback resolver reads it two ways —
// eventData.oppref directly, and the clickIdType/clickId pair
// (postback/platforms/openai.js:121-131) — so both must be produced.

export {};

import { AttributionManager } from './attribution';

function withUrl(search: string) {
  window.history.replaceState({}, '', `/landing${search}`);
}

describe('WEB-28 — oppref capture', () => {
  beforeEach(() => {
    localStorage.clear();
    withUrl('');
  });

  it('captures oppref from the landing URL under its own key', () => {
    withUrl('?oppref=op_abc123');
    const attribution = new AttributionManager({} as never);
    const data = attribution.getAttributionData();
    expect(data.oppref).toBe('op_abc123');
  });

  it('exposes it as the clickId/clickIdType pair the postback resolver reads', () => {
    withUrl('?oppref=op_abc123');
    const attribution = new AttributionManager({} as never);
    const data = attribution.getAttributionData();
    expect(data.clickIdType).toBe('oppref');
    expect(data.clickId).toBe('op_abc123');
  });

  it('does not outrank fbclid or gclid when several are present', () => {
    // Priority order is load-bearing: the first present click id becomes the
    // canonical clickId, and OpenAI must not displace the majors.
    withUrl('?fbclid=fb_1&oppref=op_1');
    const attribution = new AttributionManager({} as never);
    const data = attribution.getAttributionData();
    expect(data.clickIdType).toBe('fbclid');
    // …but it is still captured under its own key alongside.
    expect(data.oppref).toBe('op_1');
  });
});
