#!/usr/bin/env bun
/**
 * Imports one book's most-liked Goodreads quotes into quotes.json, in two steps so
 * the non-Arabic ones can be translated in between (by the admin panel's
 * "famous book" Claude task, ../elhellal-books/.claude/skills/famous-book):
 *
 *   fetch  finds the book on Goodreads and writes a plan file: the author, the book
 *          and up to --limit quotes from its /work/quotes/ pages. Quotes already
 *          in Arabic (from an Arabic edition) come first and are kept verbatim; the
 *          rest are filled in by likes with an empty `text` to translate. Quotes
 *          already in quotes.json count towards the limit and are left out.
 *   apply  checks the plan (Arabic author name, book title and every quote text)
 *          and merges it into quotes.json as author > book > quote, with the same
 *          ids import-goodreads-quotes.ts uses, so re-running either never duplicates.
 *
 * Usage:
 *   bun scripts/import-goodreads-book.ts fetch "<title | Goodreads book URL | book id>" [--limit 50] [--out plan.json]
 *   bun scripts/import-goodreads-book.ts apply [plan.json]
 *
 * The plan defaults to tmp/book-import.json (git-ignored).
 */

import fs from 'fs';
import path from 'path';
import type { QuotesConfig, QuoteAuthor, QuoteBook, QuoteItem } from '../src/types/index.ts';
import { slugifyTag } from '../src/utils/tag-slug.ts';
import { PAGE_DELAY_MS, extractAuthorInfo, fetchPage, isArabicText, makeId, parseQuotes, sleep, toHiResGoodreadsImage, type Html, type ScrapedQuote } from './lib/goodreads.ts';

const QUOTES_PATH = path.join(import.meta.dir, '../src/data/quotes.json');
const DEFAULT_PLAN = path.join(import.meta.dir, '../tmp/book-import.json');
const MAX_PAGES = 10; // 30 quotes a page; past ~300 the likes are in single digits

export interface BookPlan {
    source: { bookUrl: string; workQuotesUrl: string; authorGoodreadsSlug: string };
    /** `name`: Arabic; prefilled from quotes.json or an Arabic Goodreads name, else to fill. */
    author: { nameRaw: string; name: string; image?: string; existingSlug?: string; nameHints: string[] };
    /** `title`: Arabic; prefilled when the Goodreads edition is Arabic. `slug` defaults to slugifyTag(title). */
    book: { titleRaw: string; title: string; slug?: string; cover?: string; firstPublished?: string };
    /** `text`: Arabic; already set for Arabic quotes, empty for ones to translate. `tags`: Arabic, optional. */
    quotes: { id: string; original: string; text: string; likes?: number; tagsOriginal: string[]; tags: string[] }[];
    alreadyStored: number;
}

const readQuotes = (): QuotesConfig => JSON.parse(fs.readFileSync(QUOTES_PATH, 'utf-8'));
const allIds = (config: QuotesConfig) => new Set(config.authors.flatMap((a) => [...a.quotes, ...a.books.flatMap((b) => b.quotes)].map((q) => q.id)));

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
}

/** A Goodreads book page from a URL, a numeric book id, or the first search result for a title. */
async function resolveBookPage(query: string): Promise<{ url: string; root: Html }> {
    if (/goodreads\.com\/(book\/show|work)\//.test(query) || /^\d+$/.test(query)) {
        const page = await fetchPage(/^\d+$/.test(query) ? `/book/show/${query}` : query);
        if (!page) throw new Error(`Could not open ${query}`);
        return page;
    }
    const search = await fetchPage(`/search?q=${encodeURIComponent(query)}`);
    const href = search?.root.querySelector('a.bookTitle')?.getAttribute('href');
    if (!href) throw new Error(`No Goodreads book found for “${query}”`);
    await sleep(PAGE_DELAY_MS);
    const page = await fetchPage(href.split('?')[0]!);
    if (!page) throw new Error(`Could not open ${href}`);
    return page;
}

async function fetchPlan(query: string, limit: number): Promise<BookPlan> {
    const book = await resolveBookPage(query);
    const root = book.root;
    const titleRaw = (root.querySelector('h1[data-testid="bookTitle"]')?.text || root.querySelector('meta[property="og:title"]')?.getAttribute('content') || '').trim();
    const workHref = root.querySelector('a[href*="/work/quotes/"]')?.getAttribute('href')?.split('?')[0]?.replace(/^https:\/\/www\.goodreads\.com/, '');
    const authorGoodreadsSlug = root.querySelector('a[href*="/author/show/"]')?.getAttribute('href')?.match(/\/author\/show\/([^/?#]+)/)?.[1];
    if (!titleRaw || !workHref || !authorGoodreadsSlug) throw new Error(`${book.url} has no title, author or quotes link — is it a book page?`);
    const ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute('content');
    const cover = ogImage && !/nophoto/.test(ogImage) ? toHiResGoodreadsImage(ogImage) : undefined;
    const nameHints = [...new Set(root.querySelectorAll('.ContributorLink__name').map((n) => n.text.trim()).filter(Boolean))];
    const firstPublished = root.querySelector('[data-testid="publicationInfo"]')?.text.trim();
    console.log(`📖 ${titleRaw} — ${book.url}`);

    await sleep(PAGE_DELAY_MS);
    const authorPage = await fetchPage(`/author/quotes/${authorGoodreadsSlug}`);
    const authorInfo = authorPage ? extractAuthorInfo(authorPage.root) : null;
    const nameRaw = authorInfo?.name || nameHints[0] || authorGoodreadsSlug;
    console.log(`👤 ${nameRaw} (${authorGoodreadsSlug})`);

    const config = readQuotes();
    const stored = allIds(config);
    const existing = config.authors.find((a) => a.goodreadsSlug === authorGoodreadsSlug);

    // Goodreads lists a work's quotes most-liked first, every language mixed together.
    const scraped: ScrapedQuote[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
        await sleep(PAGE_DELAY_MS);
        const result = await fetchPage(`${workHref}?page=${page}`);
        const fresh = result ? parseQuotes(result.root).filter((q) => !seen.has(q.textRaw)) : [];
        if (!fresh.length) break;
        fresh.forEach((q) => seen.add(q.textRaw));
        scraped.push(...fresh);
        const arabic = scraped.filter((q) => isArabicText(q.textRaw)).length;
        console.log(`   page ${page}: ${scraped.length} quotes (${arabic} Arabic)`);
        if (arabic >= limit) break;
        if (scraped.length >= limit && page >= 3) break; // enough to choose from; Arabic ones this deep are rare
    }

    const withIds = scraped.map((q) => ({ ...q, id: makeId(authorGoodreadsSlug, q.textRaw) }));
    const alreadyStored = withIds.filter((q) => stored.has(q.id)).length;
    const candidates = withIds.filter((q) => !stored.has(q.id));
    const wanted = Math.max(0, limit - alreadyStored);
    const arabic = candidates.filter((q) => isArabicText(q.textRaw));
    const picked = new Set([...arabic, ...candidates.filter((q) => !isArabicText(q.textRaw))].slice(0, wanted));
    const quotes = candidates.filter((q) => picked.has(q)).map((q) => {
        const isArabic = isArabicText(q.textRaw);
        return { id: q.id, original: q.textRaw, text: isArabic ? q.textRaw : '', ...(q.likes !== undefined ? { likes: q.likes } : {}), tagsOriginal: q.tags, tags: [] as string[] };
    });

    return {
        source: { bookUrl: book.url.split('?')[0]!, workQuotesUrl: `https://www.goodreads.com${workHref}`, authorGoodreadsSlug },
        author: {
            nameRaw,
            name: existing?.name || (isArabicText(nameRaw) ? nameRaw : ''),
            ...(authorInfo?.image ? { image: authorInfo.image } : {}),
            ...(existing ? { existingSlug: existing.slug } : {}),
            nameHints,
        },
        book: { titleRaw, title: isArabicText(titleRaw) ? titleRaw : '', ...(cover ? { cover } : {}), ...(firstPublished ? { firstPublished } : {}) },
        quotes,
        alreadyStored,
    };
}

/** What's wrong with a plan before it can be applied; empty when it's ready. */
export function planProblems(plan: BookPlan): string[] {
    const problems: string[] = [];
    if (!isArabicText(plan.author.name || '')) problems.push('author.name must be the Arabic name');
    if (!isArabicText(plan.book.title || '')) problems.push('book.title must be the Arabic title');
    if (plan.book.slug !== undefined && !slugifyTag(plan.book.slug)) problems.push('book.slug is empty after slugifying');
    plan.quotes.forEach((q, i) => {
        if (!q.text?.trim()) problems.push(`quotes[${i}] (${q.id}) has no text`);
        else if (!isArabicText(q.text)) problems.push(`quotes[${i}] (${q.id}) text is not Arabic`);
    });
    return problems;
}

function apply(plan: BookPlan) {
    const problems = planProblems(plan);
    if (problems.length) {
        console.error(`❌ The plan isn't ready:\n - ${problems.slice(0, 20).join('\n - ')}${problems.length > 20 ? `\n - …and ${problems.length - 20} more` : ''}`);
        process.exit(1);
    }

    const config = readQuotes();
    const stored = allIds(config);
    const name = plan.author.name.trim();
    const nameSlug = slugifyTag(name);

    // The Goodreads slug identifies the author; failing that, an entry added under the same name (e.g. from a tweet).
    let author: QuoteAuthor | undefined = config.authors.find((a) => a.goodreadsSlug === plan.source.authorGoodreadsSlug)
        ?? config.authors.find((a) => !a.goodreadsSlug && a.slug === nameSlug);
    const newAuthor = !author;
    if (!author) {
        const taken = config.authors.some((a) => a.slug === nameSlug);
        const slug = taken ? `${nameSlug}-${plan.source.authorGoodreadsSlug.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)}` : nameSlug;
        author = { slug, goodreadsSlug: plan.source.authorGoodreadsSlug, name, ...(plan.author.image ? { image: plan.author.image } : {}), quotes: [], books: [] };
        config.authors.push(author);
    } else {
        author.goodreadsSlug ??= plan.source.authorGoodreadsSlug;
        if (!author.image && plan.author.image) author.image = plan.author.image;
    }

    // An existing book holding some of these quotes (e.g. an English-titled one from the author importer) is reused.
    const planIds = new Set(plan.quotes.map((q) => q.id));
    const slug = slugifyTag(plan.book.slug || plan.book.title);
    let book: QuoteBook | undefined = author.books.find((b) => b.slug === slug) ?? author.books.find((b) => b.quotes.some((q) => planIds.has(q.id)));
    if (!book) {
        book = { slug, title: plan.book.title.trim(), ...(plan.book.cover ? { cover: plan.book.cover } : {}), quotes: [] };
        author.books.push(book);
    } else if (!book.cover && plan.book.cover) book.cover = plan.book.cover;

    let added = 0;
    for (const q of plan.quotes) {
        if (stored.has(q.id)) continue;
        const tags = (q.tags ?? []).map((t) => t.trim()).filter((t) => t && isArabicText(t));
        const item: QuoteItem = { id: q.id, text: q.text.trim(), ...(tags.length ? { tags } : {}), ...(q.likes !== undefined ? { likes: q.likes } : {}) };
        book.quotes.push(item);
        stored.add(q.id);
        added++;
    }
    book.quotes.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));

    fs.writeFileSync(QUOTES_PATH, JSON.stringify(config, null, 2) + '\n');
    const result = { authorSlug: author.slug, authorName: author.name, newAuthor, bookSlug: book.slug, bookTitle: book.title, cover: book.cover, added, bookQuotes: book.quotes.length };
    console.log(`✅ ${added} quotes added to «${book.title}» by ${author.name} (${book.quotes.length} on the book)`);
    console.log(JSON.stringify(result));
}

const [cmd, target] = process.argv.slice(2);
if (cmd === 'fetch' && target) {
    const limit = Math.max(1, Math.min(300, Number(arg('--limit')) || 50));
    const out = path.resolve(arg('--out') || DEFAULT_PLAN);
    const plan = await fetchPlan(target, limit);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
    const toTranslate = plan.quotes.filter((q) => !q.text).length;
    console.log(`\n💾 ${out}`);
    console.log(`   ${plan.quotes.length} new quotes (${plan.quotes.length - toTranslate} Arabic, ${toTranslate} to translate), ${plan.alreadyStored} already in quotes.json`);
    const todo = planProblems(plan).filter((p) => !p.startsWith('quotes['));
    if (todo.length) console.log(`   to fill: ${todo.join('; ')}`);
} else if (cmd === 'apply') {
    const file = path.resolve(target && !target.startsWith('--') ? target : DEFAULT_PLAN);
    apply(JSON.parse(fs.readFileSync(file, 'utf-8')) as BookPlan);
} else {
    console.error('usage: bun scripts/import-goodreads-book.ts fetch "<title | Goodreads URL | book id>" [--limit 50] [--out plan.json]\n       bun scripts/import-goodreads-book.ts apply [plan.json]');
    process.exit(2);
}
