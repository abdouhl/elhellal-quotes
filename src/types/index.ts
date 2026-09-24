export interface QuoteItem {
    id: string;                 // stable hash of authorSlug+cleaned text, used for dedup across scraper re-runs
    text: string;                // final Arabic text — verbatim original wording (just cleaned) if source was already Arabic, else AI-translated
    tags?: string[];              // goodreads topic tags, translated to Arabic
    likes?: number;
    sourceUrl?: string;          // set for quotes imported from a tweet (scripts/generate-tweet-quote.ts) — link back to the original post
}

export interface QuoteBook {
    slug: string;
    title: string;             // Arabic book title
    cover?: string;             // book cover image URL
    quotes: QuoteItem[];
}

export interface QuoteAuthor {
    slug: string;               // human-readable slug generated from the Arabic name, used for /[author]
    goodreadsSlug?: string;      // original Goodreads author slug (e.g. "1069006.Naval_Ravikant") — only used to re-fetch/dedupe against Goodreads, never in a URL. Absent for authors added from tweets.
    twitterHandle?: string;      // X/Twitter screen_name (no @), set for authors added by scripts/generate-tweet-quote.ts
    name: string;                // Arabic author name
    image?: string;               // goodreads author photo URL
    quotes: QuoteItem[];          // quotes not tagged with a specific book
    books: QuoteBook[];
}

export interface QuotesConfig {
    authors: QuoteAuthor[];
}

/** Flattened view of a single quote with its author/book context inlined — used by pages/components that render one quote at a time. */
export interface FlatQuote {
    id: string;
    text: string;
    tags?: string[];
    likes?: number;
    author: string;
    authorSlug: string;
    authorImage?: string;
    book?: string;
    bookSlug?: string;
    bookCover?: string;
}
