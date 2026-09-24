/**
 * Pure tag-slug helpers with no data dependency, split out of utils/tags.ts.
 * That file also pulls in the full articles.json for its article-tag index;
 * importing anything from it drags that ~30MB dataset into whatever bundle
 * needs it, which blew past the Cloudflare Worker's 64MB size limit for the
 * on-demand quote routes. Quote code should import from here instead.
 */

export function normalizeTag(raw: string): string {
    return raw.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

export function slugifyTag(raw: string): string {
    return normalizeTag(raw)
        .replace(/\//g, '-')                 // "/" would otherwise split the route into two segments (e.g. P/E-Ratio)
        .replace(/\s+/g, '-')                // spaces -> hyphen
        .replace(/[^\p{L}\p{N}-]/gu, '');     // strip anything else unsafe; \p{L}/\p{N} keep Arabic + other unicode letters/numbers
}
