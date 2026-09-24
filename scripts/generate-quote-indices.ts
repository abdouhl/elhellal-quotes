import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { QuotesConfig, FlatQuote } from '../src/types/index.ts';
import { normalizeTag, slugifyTag } from '../src/utils/tag-slug.ts';
import { extractAlTopicWords, MIN_QUOTES_PER_TAG } from '../src/utils/quotes.ts';
import { SHARD_COUNT, shardOf } from '../src/utils/quote-shard.ts';

// Precomputes everything the SSR quote routes (`quotes/[author]/[id].astro`
// and `quotes/tag/[tag].astro`) need, so those routes do one cheap dynamic
// import per request instead of loading the full ~8MB quotes.json and
// rebuilding indices (including per-quote regex tag extraction) on every
// Worker invocation. That per-request cost was blowing through Cloudflare's
// free-tier CPU limit — these routes stay SSR (prerendering all ~15k quote
// pages would blow the 20,000 static-asset limit instead), but the
// per-request work now only touches one small precomputed shard.
//
// Output is sharded (a fixed number of files, each holding many entries)
// rather than one file per quote/tag: with ~15k quotes and ~5k qualifying
// tags, one-file-per-key made Vite's SSR bundler analyze ~20k extra dynamic
// import targets on top of the ~11k article-metadata files it already
// handles, which pushed the build past Node's default heap limit (OOM,
// "Building server entrypoints"). Sharding keeps the per-request lookup just
// as cheap (parse one small shard, then a plain object/Map lookup) while
// keeping the file count the bundler has to deal with bounded.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔧 Generating quote lookup indices...\n');

const quotesPath = path.join(__dirname, '../src/data/quotes.json');
// Written to public/ (served as static assets, fetched at runtime via the
// ASSETS binding) rather than src/data/: dynamically importing ~120MB of
// shard JSON made Vite inline all of it into the Worker bundle, which ran the
// build out of heap ("Building server entrypoints").
const byIdDir = path.join(__dirname, '../public/_quotes/by-id');
const byTagDir = path.join(__dirname, '../public/_quotes/by-tag');

for (const dir of [byIdDir, byTagDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

try {
    if (!fs.existsSync(quotesPath)) {
        throw new Error(`quotes.json not found at ${quotesPath}`);
    }
    const data: QuotesConfig = JSON.parse(fs.readFileSync(quotesPath, 'utf-8'));

    // 1. Flatten, same as utils/quotes.ts getQuotes().
    const flatQuotes: FlatQuote[] = [];
    for (const author of data.authors) {
        for (const q of author.quotes) {
            flatQuotes.push({
                ...q,
                author: author.name,
                authorSlug: author.slug,
                ...(author.image ? { authorImage: author.image } : {}),
            });
        }
        for (const book of author.books) {
            for (const q of book.quotes) {
                flatQuotes.push({
                    ...q,
                    author: author.name,
                    authorSlug: author.slug,
                    ...(author.image ? { authorImage: author.image } : {}),
                    book: book.title,
                    bookSlug: book.slug,
                    ...(book.cover ? { bookCover: book.cover } : {}),
                });
            }
        }
    }

    // 2. Group by author (in flattened order) so each quote's "other quotes by
    //    this author" slice can be precomputed without a per-request O(n) scan.
    const quotesByAuthor = new Map<string, FlatQuote[]>();
    for (const q of flatQuotes) {
        const list = quotesByAuthor.get(q.authorSlug) || [];
        list.push(q);
        quotesByAuthor.set(q.authorSlug, list);
    }

    // 3. Build the by-id payload for every quote — the quote itself, its
    //    author's total quote count (for the sidebar), and up to 6 other
    //    quotes by the same author (exactly what quotes/[author]/[id].astro
    //    renders) — then bucket into SHARD_COUNT files keyed by id.
    const idShards: Record<string, Record<string, unknown>>[] = Array.from({ length: SHARD_COUNT }, () => ({}));
    for (const quote of flatQuotes) {
        const authorQuotes = quotesByAuthor.get(quote.authorSlug) || [];
        const otherQuotes = authorQuotes.filter((q) => q.id !== quote.id).slice(0, 6);
        const payload = { ...quote, authorQuoteCount: authorQuotes.length, otherQuotes };
        const idx = parseInt(shardOf(quote.id), 16);
        idShards[idx][quote.id] = payload;
    }

    let idBytes = 0;
    idShards.forEach((shard, idx) => {
        const json = JSON.stringify(shard);
        fs.writeFileSync(path.join(byIdDir, `${idx.toString(16).padStart(2, '0')}.json`), json);
        idBytes += json.length;
    });

    // 4. Build the tag index (curated `tags` field + extracted "ال" topic
    //    words) exactly as buildQuoteTagIndex() does, but once, at build
    //    time, then bucket qualifying tags into SHARD_COUNT files by slug.
    const tagMap = new Map<string, { slug: string; label: string; quotes: FlatQuote[] }>();
    const addTag = (quote: FlatQuote, rawTag: string) => {
        const label = normalizeTag(rawTag);
        if (!label) return;
        const slug = slugifyTag(rawTag);
        if (!slug) return;
        if (!tagMap.has(slug)) {
            tagMap.set(slug, { slug, label, quotes: [] });
        }
        const entry = tagMap.get(slug)!;
        if (!entry.quotes.some((q) => q.id === quote.id)) {
            entry.quotes.push(quote);
        }
    };
    for (const quote of flatQuotes) {
        // Guard against malformed source data (e.g. a tag stored as a nested
        // array instead of a string) so one bad quote can't crash the whole build.
        (quote.tags || []).filter((t): t is string => typeof t === 'string').forEach((rawTag) => addTag(quote, rawTag));
        extractAlTopicWords(quote.text).forEach((word) => addTag(quote, word));
    }

    const tagShards: Record<string, { label: string; quotes: FlatQuote[] }>[] = Array.from({ length: SHARD_COUNT }, () => ({}));
    let tagFiles = 0;
    for (const entry of tagMap.values()) {
        if (entry.quotes.length < MIN_QUOTES_PER_TAG) continue; // matches the old runtime 404 threshold
        const idx = parseInt(shardOf(entry.slug), 16);
        tagShards[idx][entry.slug] = { label: entry.label, quotes: entry.quotes };
        tagFiles++;
    }

    let tagBytes = 0;
    tagShards.forEach((shard, idx) => {
        const json = JSON.stringify(shard);
        fs.writeFileSync(path.join(byTagDir, `${idx.toString(16).padStart(2, '0')}.json`), json);
        tagBytes += json.length;
    });

    console.log(`✨ Wrote ${flatQuotes.length} quotes across ${SHARD_COUNT} quote-by-id shards (${(idBytes / 1024).toFixed(0)} KB)`);
    console.log(`✨ Wrote ${tagFiles} tags across ${SHARD_COUNT} quote-by-tag shards (${(tagBytes / 1024).toFixed(0)} KB, ${tagMap.size - tagFiles} below the ${MIN_QUOTES_PER_TAG}-quote threshold)`);
    console.log(`📁 Output: ${byIdDir}`);
    console.log(`📁 Output: ${byTagDir}`);
} catch (error: any) {
    console.error('❌ Error generating quote indices:', error.message);
    process.exit(1);
}
