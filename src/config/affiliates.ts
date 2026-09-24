/**
 * Affiliate settings for the "احصل على الكتاب" links on book pages.
 *
 * AMAZON_TAG: your Amazon Associates tracking ID (e.g. "elhellal-21"). Associates
 * IDs are per-marketplace, so it must belong to AMAZON_DOMAIN. While empty, the
 * Amazon link still works as a plain (untracked) search link.
 */
export const AMAZON_DOMAIN = "www.amazon.com";
export const AMAZON_TAG = "";

export function amazonSearchUrl(query: string): string {
    const params = new URLSearchParams({ k: query });
    if (AMAZON_TAG) params.set("tag", AMAZON_TAG);
    return `https://${AMAZON_DOMAIN}/s?${params.toString()}`;
}

export function goodreadsSearchUrl(query: string): string {
    return `https://www.goodreads.com/search?${new URLSearchParams({ q: query }).toString()}`;
}
