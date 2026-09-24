#!/usr/bin/env bun
/**
 * Syncs which quote-books have a summary on books.elhellal.com.
 * Reads ../elhellal-books/src/data/books.json and writes src/data/book-summaries.json
 * as { <quotes book slug>: <books.elhellal.com slug> }, used by the "اقرأ الملخص"
 * button on /book/<slug>. Re-run after adding a book to elhellal-books, then commit.
 *
 * Usage: bun run sync-book-summaries [--books-file path/to/books.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flag = process.argv.indexOf("--books-file");
const booksFile = flag > -1 ? process.argv[flag + 1] : join(import.meta.dir, "../../elhellal-books/src/data/books.json");
const outFile = join(import.meta.dir, "../src/data/book-summaries.json");

const books: { slug: string; quotesSlug?: string }[] = JSON.parse(readFileSync(booksFile, "utf-8"));
const map: Record<string, string> = {};
for (const b of books) {
    if (b.quotesSlug) map[b.quotesSlug] = b.slug;
}

writeFileSync(outFile, JSON.stringify(map, null, 2) + "\n");
console.log(`Wrote ${Object.keys(map).length} book summaries to src/data/book-summaries.json`);
