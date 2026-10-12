/**
 * The dedup-id contract the browser pixels share with the postback senders.
 * These cases are copied VERBATIM from the worker's tests (feat/adp-p1-worker,
 * infra/cloudflare/postback/tests/applovin.test.js "dedupe_id contract" and
 * x.test.js "conversion_id: purchase = order id as recorded"), so a change on
 * either side fails both. KEEP THE TWO TABLES IDENTICAL.
 */
import { appLovinDedupeId } from './pixels/applovin';
import { xConversionId } from './pixels/x';
import { claimLandingPageView, pixelIdFields } from './destination-pixels';

describe('dedupe_id contract (applovin.test.js, verbatim)', () => {
  test('purchases = the transaction id as sent, everything else the DATALYR event id', () => {
    expect(appLovinDedupeId({ eventName: 'purchase', transactionId: '6896206413937' })).toBe('6896206413937');
    expect(appLovinDedupeId({ eventName: 'purchase', transactionId: 6896206413937 })).toBe('6896206413937');
    expect(appLovinDedupeId({ eventName: 'purchase', transactionId: 'in_1Q2w3E' })).toBe('in_1Q2w3E'); // case kept
    expect(appLovinDedupeId({ eventName: 'purchase', transactionId: 'shopify_42' })).toBe('shopify_42'); // no prefix added or doubled
    expect(appLovinDedupeId({ eventName: 'purchase', orderId: 'ORD-9' })).toBe('ORD-9');
    expect(appLovinDedupeId({ eventName: 'add_to_cart', eventId: 'evt_7c1b', transactionId: '1' })).toBe('evt_7c1b');
    expect(appLovinDedupeId({ eventName: 'purchase', eventId: 'evt_9d2e' })).toBe('evt_9d2e');
    expect(appLovinDedupeId({})).toBe(undefined);
  });
});

describe('conversion_id contract (x.test.js, verbatim inputs)', () => {
  // x.test.js webEvent('purchase', …) carries event_id 'evt_purchase_1'; rule('PURCHASE') is a purchase,
  // rule('ADD_TO_CART') is not. The browser receives the same event_data as `properties`.
  const purchase = (data: Record<string, unknown>) => ({ value: 10, ...data });
  test.each([
    ['PURCHASE, order_id Ord-77', true, purchase({ order_id: 'Ord-77' }), 'Ord-77'],
    ['PURCHASE, no order id', true, purchase({}), 'evt_purchase_1'],
    ['ADD_TO_CART, order_id Ord-77', false, purchase({ order_id: 'Ord-77' }), 'evt_purchase_1'],
    ['PURCHASE, Stripe invoice payment', true, purchase({ object: 'invoice_payment', invoice: 'in_1Q2w', amount_paid_decimal: 12 }), 'in_1Q2w'],
    ['PURCHASE, order_id A1 (stable across rebuilds)', true, purchase({ order_id: 'A1' }), 'A1'],
  ])('%s', (_name, isPurchase, properties, expected) => {
    expect(xConversionId({ purchase: isPurchase, properties, eventId: 'evt_purchase_1' })).toBe(expected);
    // Through the raw id fields the Container hands the module: same answer.
    expect(xConversionId({ purchase: isPurchase, properties: pixelIdFields(properties), eventId: 'evt_purchase_1' })).toBe(expected);
  });
});

describe('landing page view claim', () => {
  afterEach(() => { delete (window as any).__datalyrLandingPageView; });
  test('the first page view of the page load is the landing, for every dl.js install on it', () => {
    expect(claimLandingPageView()).toBe(true);
    expect(claimLandingPageView()).toBe(false); // an SPA navigation, or a second install
    expect(claimLandingPageView()).toBe(false);
  });
});
