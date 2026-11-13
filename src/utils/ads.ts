/**
 * Where to put in-list ads on author / book / tag pages: after rows 4, 14, 24, 34, 44
 * (never in the last two rows), so the first ad follows real content. Short lists
 * (4-5 quotes) get one ad at the end; thinner pages get none (more ad than content).
 */
export function adAfterRow(i: number, total: number): boolean {
    if (total < 4) return false;
    if (total < 6) return i === total - 1;
    return i % 10 === 3 && i < 44 && i < total - 2;
}

/** In-article ad slots per template, so AdSense reports each one separately. */
export const LIST_AD_SLOTS = {
    author: "4759736498",
    book: "8063401737",
    tag: "2288330872",
} as const;
