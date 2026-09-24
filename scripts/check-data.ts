import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { QuotesConfig, QuoteItem } from '../src/types/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const quotesPath = path.join(__dirname, '../src/data/quotes.json');

const quoteIssues = {
    missing_fields: [] as string[],
    duplicate_ids: [] as string[],
    bad_length: [] as string[],
};

let totalQuotes = 0;

try {
    // Check quotes.json (nested author > book > quote)
    console.log("Checking quotes.json...");
    const quotesData: QuotesConfig = JSON.parse(fs.readFileSync(quotesPath, 'utf-8'));
    const seenIds = new Set<string>();

    const checkQuote = (quote: QuoteItem, authorSlug: string, authorName: string) => {
        totalQuotes++;
        const identifier = `"${quote.text?.slice(0, 40)}" (${authorName || 'unknown author'})`;

        if (!quote.text || !authorName || !authorSlug) {
            quoteIssues.missing_fields.push(identifier);
        }

        if (quote.text && (quote.text.length < 4 || quote.text.length > 500)) {
            quoteIssues.bad_length.push(identifier);
        }

        if (seenIds.has(quote.id)) {
            quoteIssues.duplicate_ids.push(identifier);
        }
        seenIds.add(quote.id);
    };

    quotesData.authors.forEach((author) => {
        author.quotes.forEach((q) => checkQuote(q, author.slug, author.name));
        author.books.forEach((book) => book.quotes.forEach((q) => checkQuote(q, author.slug, author.name)));
    });

    // --- Reporting ---
    const issueCount = Object.values(quoteIssues).flat().length;
    console.log(`\nReport Summary:`);
    console.log(`Total quotes processed: ${totalQuotes}`);
    console.log(`Issues found: ${issueCount}`);

    if (quoteIssues.missing_fields.length > 0) {
        console.log("\n❌ Quotes Missing Required Fields (text/author name/authorSlug):");
        quoteIssues.missing_fields.forEach(i => console.log(`   - ${i}`));
    }

    if (quoteIssues.bad_length.length > 0) {
        console.log("\n❌ Quotes with Suspicious Length (text < 4 or > 500 chars):");
        quoteIssues.bad_length.forEach(i => console.log(`   - ${i}`));
    }

    if (quoteIssues.duplicate_ids.length > 0) {
        console.log("\n❌ Duplicate Quote IDs:");
        quoteIssues.duplicate_ids.forEach(i => console.log(`   - ${i}`));
    }

    if (issueCount === 0) {
        console.log("\n✅ Data check passed! No issues found.");
    } else {
        process.exit(1);
    }
} catch (error: any) {
    console.error('❌ Error checking data:', error.message);
    process.exit(1);
}
