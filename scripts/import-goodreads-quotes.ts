#!/usr/bin/env bun
/**
 * Import author quotes from Goodreads into quotes.json, nested as
 * author > book > quote (author/book metadata stored once, not repeated
 * per quote — see src/types/index.ts QuoteAuthor/QuoteBook/QuoteItem).
 *
 * If a quote (or author name / book title) is already Arabic on Goodreads,
 * it is kept verbatim — only decorative quote marks / HTML entities / a
 * trailing dash separator are stripped, no AI rewriting of the wording.
 * Ollama (local, gemma4:e4b) is only used to translate genuinely non-Arabic
 * content (and to translate goodreads' English topic tags either way).
 *
 * Every run also re-fetches quotes for every Goodreads author slug already
 * present in quotes.json, so new quotes Goodreads adds for known authors get
 * picked up automatically. Any slugs passed on the CLI are merged into that set.
 *
 * quotes.json is saved incrementally every 10 new quotes (plus once more at
 * the end), so an interruption mid-run only costs the last <10 translations.
 *
 * Usage:
 *   bun run scripts/import-goodreads-quotes.ts [goodreads-author-slug] ...
 *
 * Example:
 *   bun run scripts/import-goodreads-quotes.ts                                    # re-check all known authors
 *   bun run scripts/import-goodreads-quotes.ts 1069006.Naval_Ravikant              # + a brand-new author
 *   bun run scripts/import-goodreads-quotes.ts 1069006.Naval_Ravikant 3389.Marcus_Aurelius
 *
 * A Goodreads author slug is the last path segment of their quotes page:
 *   https://www.goodreads.com/author/quotes/{slug}
 *
 * Requires Ollama running locally with gemma4:e4b pulled.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { QuotesConfig, QuoteAuthor, QuoteBook, QuoteItem } from '../src/types/index.ts';
import { slugifyTag } from '../src/utils/tag-slug.ts';
import { PAGE_DELAY_MS, fetchBookCover, fetchPage, extractAuthorInfo, isArabicText, makeId, parseQuotes, type AuthorInfo, type ScrapedQuote } from './lib/goodreads.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL = 'gemma4:e4b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const QUOTES_PATH = path.join(__dirname, '../src/data/quotes.json');
const OLLAMA_DELAY_MS = 400;  // between translation calls
const MAX_PAGES = 100;        // Goodreads' hard pagination cap for quotes
const MAX_QUOTES_PER_AUTHOR = 500; // cap on total stored quotes (existing + new) per author

// ─── Goodreads fetch + parse ───────────────────────────────────────────────────

interface ScrapedPage {
    quotes: ScrapedQuote[];
    authorInfo: AuthorInfo | null;
}

async function fetchQuotesPage(authorSlug: string, page: number): Promise<ScrapedPage> {
    const result = await fetchPage(`/author/quotes/${authorSlug}?page=${page}`);
    if (!result) return { quotes: [], authorInfo: null };
    return { quotes: parseQuotes(result.root), authorInfo: extractAuthorInfo(result.root) };
}

/**
 * Fetches pages for an author until a page comes back empty, adds nothing
 * new, or `limit` scraped quotes have been collected. Goodreads caps quote
 * pagination at page 100 and, for prolific authors, keeps serving that same
 * last page for every higher page number instead of an empty one — so
 * "empty page" alone never terminates. Goodreads serves quotes most-liked
 * first, so capping at `limit` keeps the most popular ones.
 */
async function fetchAllQuotesForAuthor(authorSlug: string, limit: number): Promise<{ quotes: ScrapedQuote[]; authorInfo: AuthorInfo | null }> {
    const all: ScrapedQuote[] = [];
    const seen = new Set<string>();
    let authorInfo: AuthorInfo | null = null;

    for (let page = 1; page <= MAX_PAGES && all.length < limit; page++) {
        const result = await fetchQuotesPage(authorSlug, page);
        const fresh = result.quotes.filter((q) => !seen.has(q.textRaw));
        if (fresh.length === 0) break;
        fresh.forEach((q) => seen.add(q.textRaw));
        all.push(...fresh);
        authorInfo = authorInfo || result.authorInfo;
        process.stdout.write(`   page ${page}: ${all.length} quote(s) so far\r`);
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }

    process.stdout.write('\x1b[2K'); // clear the progress line
    return { quotes: all.slice(0, limit), authorInfo };
}

// ─── Ollama (local) translation ────────────────────────────────────────────────

/** Translates/transliterates a single proper noun (author name or book title) to Arabic. */
async function translateName(nameRaw: string): Promise<string> {
    const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [{
                role: 'user',
                content: `انقل الاسم التالي إلى نقحرة عربية شائعة الاستخدام. أجب بالاسم المنقول فقط، بدون أي شرح أو علامات اقتباس:\n${nameRaw}`,
            }],
        }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json() as any;
    return (data.message?.content || '').trim().replace(/^["“]|["”]$/g, '') || nameRaw;
}

interface TranslatedQuote {
    text: string;
    tags: string[];
}

/** Translates a non-Arabic quote's text + tags to Arabic in one call. */
async function translateQuoteFull(textRaw: string, authorName: string, bookTitle: string | undefined, tags: string[]): Promise<TranslatedQuote> {
    const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [{
                role: 'user',
                content: `أنت مترجم أدبي محترف متخصص في ترجمة الاقتباسات الإنجليزية إلى العربية الفصحى بأسلوب بليغ ومحافظ على المعنى الأصلي.

الاقتباس: ${textRaw}
الكاتب: ${authorName}
${bookTitle ? `الكتاب: ${bookTitle}` : ''}
${tags.length ? `الوسوم: ${tags.join(', ')}` : ''}

ترجم ما يلي إلى العربية. أجب بـ JSON فقط بدون markdown أو أي نص خارجه:
{
  "text": "ترجمة الاقتباس بالعربية الفصحى",
  "tags": [${tags.length ? tags.map(() => '"ترجمة الوسم"').join(', ') : ''}]
}`,
            }],
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data = await res.json() as any;
    const text = (data.message?.content || '').trim()
        .replace(/^```(?:json)?\n?/, '')
        .replace(/\n?```$/, '')
        .replace(/،/g, ',');

    return JSON.parse(text) as TranslatedQuote;
}

/** Translates goodreads' English topic tags to Arabic, one call for whatever isn't already cached. */
async function translateTags(tags: string[], cache: Map<string, string>): Promise<string[]> {
    const missing = tags.filter((t) => !cache.has(t));
    if (missing.length > 0) {
        try {
            const res = await fetch(OLLAMA_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: MODEL,
                    stream: false,
                    messages: [{
                        role: 'user',
                        content: `ترجم أسماء الوسوم التالية إلى كلمة أو كلمتين بالعربية لكل منها. أجب بـ JSON فقط، مصفوفة بنفس الترتيب وبنفس العدد:\n${JSON.stringify(missing)}`,
                    }],
                }),
            });
            if (res.ok) {
                const data = await res.json() as any;
                const text = (data.message?.content || '').trim()
                    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
                const translated = JSON.parse(text) as string[];
                missing.forEach((t, i) => cache.set(t, translated[i] || t));
            } else {
                missing.forEach((t) => cache.set(t, t));
            }
        } catch {
            missing.forEach((t) => cache.set(t, t));
        }
    }
    return tags.map((t) => cache.get(t) || t);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const SAVE_EVERY = 10;

function saveQuotes(quotesConfig: QuotesConfig): void {
    fs.writeFileSync(QUOTES_PATH, JSON.stringify(quotesConfig, null, 2) + '\n');
}

/**
 * Builds the URL-facing author slug from the (Arabic) name rather than
 * Goodreads' own slug (e.g. "4603829._"), which is an opaque numeric ID and
 * makes for useless, unreadable, un-SEO-friendly URLs. Falls back to the
 * Goodreads slug only if the name doesn't yield anything usable, and
 * disambiguates the rare case of two different authors sharing a name.
 */
function slugForAuthor(config: QuotesConfig, name: string, goodreadsSlug: string): string {
    const base = slugifyTag(name) || goodreadsSlug;
    if (!config.authors.some((a) => a.slug === base)) return base;
    const disambiguator = goodreadsSlug.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
    return `${base}-${disambiguator}`;
}

function findOrCreateAuthor(config: QuotesConfig, goodreadsSlug: string, name: string, image: string | undefined): QuoteAuthor {
    let author = config.authors.find((a) => a.goodreadsSlug === goodreadsSlug);
    if (!author) {
        const slug = slugForAuthor(config, name, goodreadsSlug);
        author = { slug, goodreadsSlug, name, ...(image ? { image } : {}), quotes: [], books: [] };
        config.authors.push(author);
    } else {
        author.name = name;
        if (image) author.image = image;
    }
    return author;
}

function findOrCreateBook(author: QuoteAuthor, slug: string, title: string, cover: string | undefined): QuoteBook {
    let book = author.books.find((b) => b.slug === slug);
    if (!book) {
        book = { slug, title, ...(cover ? { cover } : {}), quotes: [] };
        author.books.push(book);
    } else {
        book.title = title;
        if (cover) book.cover = cover;
    }
    return book;
}

function collectExistingIds(config: QuotesConfig): Set<string> {
    const ids = new Set<string>();
    for (const author of config.authors) {
        author.quotes.forEach((q) => ids.add(q.id));
        author.books.forEach((b) => b.quotes.forEach((q) => ids.add(q.id)));
    }
    return ids;
}

async function main() {
    console.log('📚 Starting Goodreads quotes import...\n');

    let quotesConfig: QuotesConfig = { authors: [] };
    if (fs.existsSync(QUOTES_PATH)) {
        quotesConfig = JSON.parse(fs.readFileSync(QUOTES_PATH, 'utf-8'));
    }

    const existingIds = collectExistingIds(quotesConfig);
    const knownAuthorSlugs = new Set(quotesConfig.authors.map((a) => a.goodreadsSlug).filter((s): s is string => !!s)); // tweet-only authors have no Goodreads slug
    const cliSlugs = process.argv.slice(2);
    const authorSlugs = [...new Set([...cliSlugs, ...knownAuthorSlugs])];

    if (authorSlugs.length === 0) {
        console.log('No author slugs on the CLI and none found in quotes.json. Pass at least one Goodreads author slug.');
        process.exit(1);
    }

    console.log(`👤 Checking ${authorSlugs.length} author(s) total (${knownAuthorSlugs.size} already known${cliSlugs.length ? `, ${cliSlugs.length} passed on the CLI` : ''})\n`);

    let added = 0;
    let skipped = 0;
    let failed = 0;
    const tagCache = new Map<string, string>();

    for (const authorSlug of authorSlugs) {
        process.stdout.write(`🔎 ${authorSlug}\n`);

        const existingAuthor = quotesConfig.authors.find((a) => a.goodreadsSlug === authorSlug);
        const existingCount = existingAuthor
            ? existingAuthor.quotes.length + existingAuthor.books.reduce((n, b) => n + b.quotes.length, 0)
            : 0;
        let authorTotalCount = existingCount;
        if (existingCount >= MAX_QUOTES_PER_AUTHOR) {
            console.log(`   ⏭️  already has ${existingCount} quotes (cap ${MAX_QUOTES_PER_AUTHOR}) — skipping\n`);
            continue;
        }

        let scraped: ScrapedQuote[];
        let authorInfo: AuthorInfo | null;
        try {
            const result = await fetchAllQuotesForAuthor(authorSlug, MAX_QUOTES_PER_AUTHOR - existingCount);
            scraped = result.quotes;
            authorInfo = result.authorInfo;
        } catch (e: any) {
            console.log(`   ❌ Failed to fetch: ${e.message}`);
            failed++;
            continue;
        }

        if (!authorInfo) {
            console.log(`   ❌ Could not find author name/image on Goodreads (bad slug?)`);
            failed++;
            continue;
        }

        const sourceIsArabic = isArabicText(authorInfo.name);
        let authorName: string;
        try {
            authorName = sourceIsArabic ? authorInfo.name : await translateName(authorInfo.name);
        } catch (e: any) {
            console.log(`   ❌ Failed to resolve author name: ${e.message}`);
            failed++;
            continue;
        }
        const authorEntry = findOrCreateAuthor(quotesConfig, authorSlug, authorName, authorInfo.image);
        console.log(`   found ${scraped.length} quote(s) by ${authorName} on Goodreads (source: ${sourceIsArabic ? 'Arabic — kept verbatim' : 'non-Arabic — translating'})`);

        const bookTitleCache = new Map<string, string>();
        const bookCoverCache = new Map<string, string | undefined>();

        for (const q of scraped) {
            if (authorTotalCount >= MAX_QUOTES_PER_AUTHOR) {
                console.log(`   ⏭️  reached cap of ${MAX_QUOTES_PER_AUTHOR} quotes for ${authorName} — stopping`);
                break;
            }

            const id = makeId(authorSlug, q.textRaw);
            if (existingIds.has(id)) {
                skipped++;
                continue;
            }

            try {
                // Resolve the book (if tagged), once per unique book per author.
                let bookEntry: QuoteBook | undefined;
                if (q.bookRaw) {
                    if (!bookTitleCache.has(q.bookRaw)) {
                        bookTitleCache.set(q.bookRaw, sourceIsArabic ? q.bookRaw : await translateName(q.bookRaw));
                    }
                    if (!bookCoverCache.has(q.bookRaw)) {
                        const cover = q.bookHref ? await fetchBookCover(q.bookHref) : undefined;
                        bookCoverCache.set(q.bookRaw, cover);
                        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
                    }
                    const bookSlug = slugifyTag(q.bookRaw);
                    bookEntry = findOrCreateBook(authorEntry, bookSlug, bookTitleCache.get(q.bookRaw)!, bookCoverCache.get(q.bookRaw));
                }

                // Resolve text + tags — verbatim (just cleaned) if Arabic, else translated.
                let text: string;
                let tags: string[] | undefined;
                if (sourceIsArabic) {
                    text = q.textRaw;
                    tags = q.tags.length ? await translateTags(q.tags, tagCache) : undefined;
                } else {
                    const translated = await translateQuoteFull(q.textRaw, authorName, bookEntry?.title, q.tags);
                    text = translated.text;
                    tags = q.tags.length ? (translated.tags?.length === q.tags.length ? translated.tags : q.tags) : undefined;
                }

                const quoteItem: QuoteItem = {
                    id,
                    text,
                    ...(tags?.length ? { tags } : {}),
                    ...(q.likes !== undefined ? { likes: q.likes } : {}),
                };

                (bookEntry ? bookEntry.quotes : authorEntry.quotes).push(quoteItem);
                existingIds.add(id);
                added++;
                authorTotalCount++;
                process.stdout.write('   ✅ ' + text.slice(0, 60) + '…\n');

                if (added % SAVE_EVERY === 0) {
                    saveQuotes(quotesConfig);
                    process.stdout.write(`   💾 saved (${existingIds.size} quotes total)\n`);
                }
            } catch (e: any) {
                console.log(`   ⚠️  Failed, skipping quote: ${e.message}`);
                failed++;
            }

            await new Promise((r) => setTimeout(r, OLLAMA_DELAY_MS));
        }
    }

    saveQuotes(quotesConfig);

    console.log(`\n✨ Import complete!`);
    console.log(`   Added: ${added}`);
    console.log(`   Skipped (already known): ${skipped}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Total quotes: ${existingIds.size}`);
    console.log(`\n💾 Saved to ${QUOTES_PATH}`);
}

// Verify Ollama is reachable before starting
try {
    const res = await fetch('http://localhost:11434/api/version');
    if (!res.ok) throw new Error(`status ${res.status}`);
} catch (e: any) {
    console.error(`❌ Ollama not reachable at localhost:11434 — is it running? (${e.message})`);
    process.exit(1);
}

main();
