/**
 * Shopify product views from dl.js.
 *
 * On Shopify, `view_item` normally comes from the Datalyr Web Pixel
 * (`product_viewed`). Shopify only runs that pixel when the visitor allows
 * analytics AND marketing (its extension's customer_privacy settings), so in a
 * consent region where the visitor never answers the banner the pixel is
 * silent while dl.js may still track (the merchant chose not to wait for
 * consent). dl.js then sends the product view itself, with the same fields the
 * pixel sends, so funnels, the Ads view_item column and Meta ViewContent see it.
 */

/** Whether Shopify will run the Web Pixel for this visitor: true / false, or null while unknown. */
export function shopifyPixelWillRun(customerPrivacy: any): boolean | null {
  try {
    if (!customerPrivacy) return null;
    if (typeof customerPrivacy.analyticsProcessingAllowed !== 'function'
      || typeof customerPrivacy.marketingAllowed !== 'function') return null;
    const analytics = customerPrivacy.analyticsProcessingAllowed();
    const marketing = customerPrivacy.marketingAllowed();
    if (typeof analytics !== 'boolean' || typeof marketing !== 'boolean') return null;
    return analytics && marketing;
  } catch {
    return null;
  }
}

function metaContent(doc: Document, property: string): string | null {
  try {
    const value = doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content');
    return value ? value.trim() || null : null;
  } catch {
    return null;
  }
}

function absoluteUrl(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('//') ? `https:${value}` : value;
}

/**
 * The product view on a Shopify product page, shaped like the pixel's
 * view_item (infra/shopify/extensions/datalyr-pixel productFields), or null
 * when this is not a product page or the page carries no usable product data.
 */
export function readShopifyProductView(win: any, doc: Document): Record<string, unknown> | null {
  try {
    const meta = win?.ShopifyAnalytics?.meta ?? win?.meta;
    if (!meta) return null;
    const pageType = meta.page?.pageType;
    if (pageType && pageType !== 'product') return null;
    const product = meta.product;
    if (!product || product.id === undefined || product.id === null) return null;
    const variants: any[] = Array.isArray(product.variants) ? product.variants : [];

    let requested: string | null = null;
    try {
      requested = new URLSearchParams(win.location?.search ?? '').get('variant');
    } catch {
      requested = null;
    }
    const wanted = requested || (meta.selectedVariantId ? String(meta.selectedVariantId) : null);
    const variant = (wanted && variants.find((v) => String(v?.id) === wanted)) || variants[0] || null;

    const currency = win?.Shopify?.currency?.active || meta.currency || null;
    const cents = Number(variant?.price);
    const price = variant && Number.isFinite(cents) ? cents / 100 : null;

    // meta.product has no title; the variant name is "<product> - <variant>".
    const variantTitle = variant?.public_title || null;
    let productTitle: string | null = null;
    if (typeof variant?.name === 'string' && variant.name) {
      productTitle = variantTitle && variant.name.endsWith(` - ${variantTitle}`)
        ? variant.name.slice(0, -(variantTitle.length + 3))
        : variant.name;
    }
    if (!productTitle) productTitle = metaContent(doc, 'og:title');

    const path = typeof win.location?.pathname === 'string' && win.location.pathname.includes('/products/')
      ? win.location.pathname
      : null;

    return {
      product_id: String(product.id),
      product_title: productTitle,
      variant_id: variant?.id !== undefined && variant?.id !== null ? String(variant.id) : null,
      variant_title: variantTitle,
      sku: variant?.sku || null,
      quantity: 1,
      unit_price: price,
      line_value: null,
      product_url: path,
      image_url: absoluteUrl(metaContent(doc, 'og:image:secure_url') || metaContent(doc, 'og:image')),
      categories: product.type ? [product.type] : [],
      price,
      currency,
      tracked_via: 'dl_storefront',
    };
  } catch {
    return null;
  }
}
