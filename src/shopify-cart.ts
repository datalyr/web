/**
 * The id part of a Shopify cart token, which Shopify hands out as
 * "<id>?key=<secret>" (from /cart/update.js, or URL-encoded in the `cart`
 * cookie). The key grants access to the cart and is never returned. The id is
 * what the order webhook carries as `cart_token`. Shape-checked like the
 * server's checkout-token check, so nothing unexpected is ever sent.
 */
export function shopifyCartId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // not URL-encoded
  }
  const id = value.split('?')[0];
  return /^[A-Za-z0-9]{16,64}$/.test(id) ? id : null;
}
