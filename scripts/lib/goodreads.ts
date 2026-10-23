/**
 * Goodreads scraping helpers shared by import-goodreads-quotes.ts (an author's
 * quotes) and import-goodreads-book.ts (one book's quotes).
 */

import crypto from 'crypto';
import { parse } from 'node-html-parser';

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const PAGE_DELAY_MS = 1800;   // between Goodreads page/cover fetches — be a well-behaved scraper
export const FETCH_TIMEOUT_MS = 30_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Text cleanup ───────────────────────────────────────────────────────────────

/** Decodes the handful of HTML entities Goodreads' raw quote text nodes contain. */
export function decodeEntities(s: string): string {
    return s
        .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
        .replace(/&lsquo;/g, '‘').replace(/&rsquo;/g, '’')
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Strips the decorative wrapping quote marks and any trailing dash-style
 * separator (em/en dash, horizontal bar) left over from Goodreads' markup —
 * without touching a single word of the actual quote.
 */
export function cleanQuoteText(raw: string): string {
    let t = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    t = t.replace(/^[“‘"']\s*/, '');

    // The raw text is "...quote” ―" — a closing quote mark THEN a trailing
    // dash separator. Stripping them in a fixed order only works if that's
    // exactly the order present; looping until stable handles either order
    // (or several stacked artifacts) without touching any actual wording.
    let prev: string;
    do {
        prev = t;
        t = t.replace(/\s*[—–―-]\s*$/, '').replace(/\s*[”’"']\s*$/, '').trim();
    } while (t !== prev);

    return t;
}

/** True if the majority of alphabetic characters in `s` are Arabic script. */
export function isArabicText(s: string): boolean {
    const arabic = (s.match(/[؀-ۿ]/g) || []).length;
    const latin = (s.match(/[a-zA-Z]/g) || []).length;
    return arabic > latin;
}

/**
 * Goodreads serves book/author photos via i.gr-assets.com at a small, cropped
 * size no matter what _SX###_/_UX###_ suffix is requested — the crop is baked
 * into that host's cache. The same asset is also mirrored uncropped, at its
 * full native resolution, on Amazon's own CDN under an "i" folder with no
 * size suffix at all. Swap to that instead of asking i.gr-assets.com for a
 * "bigger" size it can't actually deliver.
 */
export function toHiResGoodreadsImage(url: string): string {
    const m = url.match(/^https:\/\/i\.gr-assets\.com\/images\/S\/compressed\.photo\.goodreads\.com\/(books|authors)\/(\d+)[a-z]\/(\d+)\./);
    if (!m) return url;
    const [, type, photoId, assetId] = m;
    return `https://m.media-amazon.com/images/S/compressed.photo.goodreads.com/${type}/${photoId}i/${assetId}.jpg`;
}

/** Stable quote id: hash of the Goodreads author slug + cleaned original text, used for dedup across re-runs. */
export function makeId(authorSlug: string, cleanedText: string): string {
    return crypto.createHash('md5').update(`${authorSlug}::${cleanedText}`).digest('hex').slice(0, 16);
}

// ─── Fetch + parse ─────────────────────────────────────────────────────────────

export interface ScrapedQuote {
    textRaw: string;
    bookRaw?: string;
    bookHref?: string;
    tags: string[];
    likes?: number;
}

export interface AuthorInfo {
    name: string;
    image?: string;
}

export type Html = ReturnType<typeof parse>;

/** GETs a Goodreads page (path or absolute URL) and parses it; null on a non-2xx. */
export async function fetchPage(urlOrPath: string): Promise<{ url: string; root: Html } | null> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : `https://www.goodreads.com${urlOrPath}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return { url: res.url || url, root: parse(await res.text()) };
}

/**
 * On an author's own /author/quotes/{slug} page, Goodreads only marks up the
 * BOOK title as a link (`a.authorOrTitle`) — the author name itself is plain
 * text in a sibling `span.authorOrTitle` (redundant with the page context).
 * Querying only `a.authorOrTitle` therefore grabs the book, not the author;
 * `.authorOrTitle` (span + a) must be used, with the first match = author,
 * second (if present) = book.
 */
export function extractAuthorInfo(root: Html): AuthorInfo | null {
    const img = root.querySelector('.leftContainer a.quoteAvatar img');
    const name = img?.getAttribute('alt')?.trim();
    if (!name) return null;
    const rawImage = img?.getAttribute('src');
    const image = rawImage ? toHiResGoodreadsImage(rawImage) : undefined;
    return { name, ...(image ? { image } : {}) };
}

/** Every `.quoteDetails` block on a Goodreads quotes listing (author, work or tag page). */
export function parseQuotes(root: Html): ScrapedQuote[] {
    const quotes: ScrapedQuote[] = [];

    for (const block of root.querySelectorAll('.quoteDetails')) {
        const textEl = block.querySelector('.quoteText');
        if (!textEl) continue;

        // .quoteText's own text nodes (before/around the trailing author/book
        // tags) hold the quote itself plus a trailing separator — cleanQuoteText
        // strips both without altering the actual wording.
        const rawText = textEl.childNodes
            .filter((n: any) => n.nodeType === 3) // text nodes only
            .map((n: any) => n.rawText || '')
            .join(' ');
        const textRaw = cleanQuoteText(rawText);
        if (!textRaw || textRaw.length < 4) continue;

        // First .authorOrTitle = author name (plain span, redundant here),
        // second (if present, always an <a>) = book title.
        const authorOrTitleEls = textEl.querySelectorAll('.authorOrTitle');
        const bookLink = authorOrTitleEls[1] as any;
        const bookRaw = bookLink?.text?.trim() || undefined;
        const bookHref = bookLink?.getAttribute?.('href') || undefined;

        const footer = block.querySelector('.quoteFooter');
        const tags = footer
            ? footer.querySelectorAll('a[href*="/quotes/tag/"]').map((a: any) => a.text.trim()).filter(Boolean)
            : [];

        // The tags container is also tagged `.smallText`, so the likes link
        // (an <a>, uniquely) must be selected specifically — a bare
        // `.smallText` query matches the tags <div> first since it comes
        // first in document order.
        const likesText = footer?.querySelector('a.smallText')?.text || '';
        const likesMatch = likesText.replace(/,/g, '').match(/(\d+)\s*likes?/i);
        const likes = likesMatch ? parseInt(likesMatch[1]!, 10) : undefined;

        quotes.push({
            textRaw,
            tags,
            ...(bookRaw ? { bookRaw, ...(bookHref ? { bookHref } : {}) } : {}),
            ...(likes !== undefined ? { likes } : {}),
        });
    }

    return quotes;
}

/** Fetches a book's own Goodreads quotes page to grab its cover thumbnail. */
export async function fetchBookCover(bookHref: string): Promise<string | undefined> {
    try {
        const page = await fetchPage(bookHref);
        const src = page?.root.querySelector('a.leftAlignedImage:not(.quoteAvatar) img')?.getAttribute('src');
        return src ? toHiResGoodreadsImage(src) : undefined;
    } catch {
        return undefined;
    }
}
