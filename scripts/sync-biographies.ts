#!/usr/bin/env bun
/**
 * Syncs which quote-authors have a biography on biographies.elhellal.com.
 * Reads ../elhellal-biographies/src/data/authors.json and writes src/data/biographies.json
 * as a list of author slugs (they match the /<slug> slugs on quotes.elhellal.com), used by the
 * "اقرأ السيرة" button on /<author>. Re-run after adding an author to
 * elhellal-biographies, then commit.
 *
 * Usage: bun run sync-biographies [--authors-file path/to/authors.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flag = process.argv.indexOf("--authors-file");
const authorsFile = flag > -1 ? process.argv[flag + 1] : join(import.meta.dir, "../../elhellal-biographies/src/data/authors.json");
const outFile = join(import.meta.dir, "../src/data/biographies.json");

const authors: { slug: string }[] = JSON.parse(readFileSync(authorsFile, "utf-8"));
const slugs = authors.map((a) => a.slug).sort((a, b) => a.localeCompare(b, "ar"));

writeFileSync(outFile, JSON.stringify(slugs, null, 2) + "\n");
console.log(`Wrote ${slugs.length} biographies to src/data/biographies.json`);
