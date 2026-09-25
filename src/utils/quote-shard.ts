/**
 * Deterministic djb2 hash bucketing shared between scripts/generate-quote-indices.ts
 * (which writes the shards) and the SSR quote routes (which read them). Must
 * stay in sync with the build script — same hash, same SHARD_COUNT — or a
 * request would look up the wrong shard and always miss.
 */
// Kept high so each shard is small (~60–80KB): JSON-parsing a multi-MB shard
// on every request is what blew the free-tier 10ms CPU budget.
export const SHARD_COUNT = 1024;

// Tag pages are paginated so no single request parses or renders more than
// this many quotes (the largest tags have 1,000+).
export const TAG_PAGE_SIZE = 30;

export function tagPageKey(slug: string, page: number): string {
    return `${slug}:${page}`;
}

export function shardOf(key: string): string {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
    }
    return (hash % SHARD_COUNT).toString(16).padStart(3, '0');
}

/**
 * Loads one precomputed quote shard from static assets (public/_quotes/).
 * Uses the Worker's ASSETS binding in production (no network hop) and falls
 * back to a same-origin fetch in `astro dev`. Returns null if the shard is
 * missing or unreadable.
 */
export async function loadQuoteShard<T>(
    kind: 'by-id' | 'by-tag',
    key: string,
    astro: { url: URL; locals: unknown },
): Promise<Record<string, T> | null> {
    const url = new URL(`/_quotes/${kind}/${shardOf(key)}.json`, astro.url);
    const assets = (astro.locals as { runtime?: { env?: { ASSETS?: { fetch: typeof fetch } } } })
        .runtime?.env?.ASSETS;
    try {
        const res = assets ? await assets.fetch(url) : await fetch(url);
        if (!res.ok) return null;
        return (await res.json()) as Record<string, T>;
    } catch {
        return null;
    }
}
