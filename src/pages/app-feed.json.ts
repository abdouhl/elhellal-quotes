// The elhellal.com app's Explore tab (src/pages/explore.astro there) reads
// this: a pool of quotes it deals one a day from. Kept small; CORS in public/_headers.
import { getQuotes } from "../utils/quotes";

const POOL = 40;

export function GET() {
    const seen = new Set<string>();
    const items = getQuotes()
        .filter((q) => q.text.length >= 40 && q.text.length <= 220)
        .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
        // At most one quote per author, so the daily rotation keeps changing voice.
        .filter((q) => !seen.has(q.authorSlug) && seen.add(q.authorSlug))
        .slice(0, POOL)
        .map((q) => ({
            text: q.text,
            title: q.author,
            meta: q.book,
            image: q.authorImage,
            url: `https://quotes.elhellal.com/${encodeURIComponent(q.authorSlug)}/${encodeURIComponent(q.id)}/`,
        }));
    return Response.json({ v: 1, site: "quotes", title: "الاقتباسات", url: "https://quotes.elhellal.com/", items });
}
