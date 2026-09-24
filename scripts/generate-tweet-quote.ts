#!/usr/bin/env bun
/**
 * Tweet -> Arabic quote card (+ quotes.json entry) — الهلال
 * ------------------------------------------------------------------
 * Takes a tweet, turns its text into an Arabic quote card (author photo, the
 * quote, author name, quotes.elhellal.com — the cream "paper" look), and adds
 * the quote to elhellal's quotes so it has its own page to link the tweet to.
 *
 *   1. Fetches the tweet from https://react-tweet.vercel.app/api/tweet/:id
 *   2. If the text isn't Arabic, translates it with Ollama (gemma4:e4b); a
 *      non-Arabic author name is transliterated the same way
 *   3. Adds it to src/data/quotes.json under the tweet's author (created on
 *      first use, matched by twitterHandle afterwards) — skipped with --no-save
 *   4. Renders the card with Puppeteer -> quote.png
 *
 * Usage:
 *   bun run scripts/generate-tweet-quote.ts <tweet-url-or-id> [more urls/ids...]
 *   bun run scripts/generate-tweet-quote.ts https://x.com/naval/status/1002103360646823936
 *   bun run scripts/generate-tweet-quote.ts 1002103360646823936 --no-save     # card only
 *   bun run scripts/generate-tweet-quote.ts <id> --dry-run                    # fetch + translate, print, write nothing
 *   bun run scripts/generate-tweet-quote.ts <id> --no-copy                    # don't put the image on the clipboard
 *   bun run scripts/generate-tweet-quote.ts <id> --text "نص مخصص"              # skip translation, use this wording
 *   bun run scripts/generate-tweet-quote.ts <id> --font Katibeh [--font-weight 400]   # other quote font (any Google Arabic font)
 *
 * Re-running for a tweet that's already in quotes.json is safe: the id is a hash
 * of author + original text, so nothing is duplicated or re-translated — the card
 * is just rendered again from the stored Arabic text.
 *
 * Output (x-posts/<date>/quote-<id>/, repo root — never inside public/):
 *   quote.png       — the card, 2000×1694
 *   tweet.txt       — tweet text: author + link to the quote page on quotes.elhellal.com
 *   alt.txt         — the quote as image alt text (accessibility)
 *   manifest.json   — what was fetched / translated / saved
 *
 * Nothing is posted — X's API needs paid credentials. The card image is copied
 * to the clipboard automatically (macOS; the last card if you pass several) —
 * paste it into the composer, paste tweet.txt, post. The quote page only exists after quotes.json is deployed.
 *
 * Requires Ollama running locally with gemma4:e4b pulled (only if a tweet or
 * author name isn't already Arabic).
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { QuotesConfig, QuoteAuthor, QuoteItem } from '../src/types/index.ts';
import { slugifyTag } from '../src/utils/tag-slug.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const VALUE_FLAGS = new Set(['--text', '--font', '--font-weight', '--out-dir', '--quotes-file', '--date']);
const TWEET_INPUTS = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''));
const DRY_RUN = args.includes('--dry-run');
const NO_SAVE = args.includes('--no-save');
const NO_COPY = args.includes('--no-copy');
const TEXT_OVERRIDE = getArg('--text');
// Aref Ruqaa Bold is the calligraphic face of the reference card. A custom --font is loaded at
// regular weight (many Arabic display fonts ship only that) unless --font-weight says otherwise.
const DEFAULT_FONT = 'Aref Ruqaa';
const QUOTE_FONT = getArg('--font') || DEFAULT_FONT;
const QUOTE_WEIGHT = parseInt(getArg('--font-weight') || (QUOTE_FONT === DEFAULT_FONT ? '700' : '400'), 10);
const DATE_OVERRIDE = getArg('--date');
const QUOTES_FILE = getArg('--quotes-file') || path.join(__dirname, '../src/data/quotes.json');
// Deliberately NOT under public/ — Astro copies everything in public/ into dist/.
const OUT_ROOT = getArg('--out-dir') || path.join(__dirname, '../x-posts');
const SITE = 'https://quotes.elhellal.com';

const MODEL = 'gemma4:e4b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const TWEET_API = 'https://react-tweet.vercel.app/api/tweet';

if (TWEET_INPUTS.length === 0) {
  console.error('Usage: bun run scripts/generate-tweet-quote.ts <tweet-url-or-id> [...] [--no-save] [--dry-run] [--text "..."] [--font "..."]');
  process.exit(1);
}
if (TEXT_OVERRIDE && TWEET_INPUTS.length > 1) {
  console.error('❌  --text applies to a single tweet.');
  process.exit(1);
}

// ─── Geometry ───────────────────────────────────────────────────────────────
// Designed at 1000×847 CSS px and rendered at 2x → 2000×1694, the proportions of the reference card.
const W = 1000;
const H = 847;
const SCALE = 2;
const MIN_QUOTE_FONT = 28;
const MAX_QUOTE_FONT = 56;

// ─── Helpers ────────────────────────────────────────────────────────────────
function xe(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Share of letters that are Arabic — a tweet with a stray English word still counts as Arabic. */
function arabicRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 1;
  const arabic = s.match(/[؀-ۿݐ-ݿࢠ-ࣿ]/g) ?? [];
  return arabic.length / letters.length;
}
const isArabic = (s: string) => arabicRatio(s) >= 0.5;

function parseTweetId(input: string): string | null {
  return input.match(/status(?:es)?\/(\d+)/)?.[1] ?? (/^\d+$/.test(input) ? input : null);
}

/** Tweet text -> one clean paragraph: only the displayed range, no t.co links, no wrapper quote marks. */
function cleanTweetText(tweet: any): string {
  let text: string = tweet.text ?? '';
  const range = tweet.display_text_range as [number, number] | undefined;
  // display_text_range is in code points and already excludes the leading reply @mentions and trailing media link.
  if (range) text = Array.from(text).slice(range[0], range[1]).join('');
  return decodeEntities(text)
    .replace(/https?:\/\/t\.co\/\w+/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"“”«»]+|[\s"“”«»]+$/g, '')
    .trim();
}

/** Display names are full of emoji, badges and separators — keep just the name. */
function cleanDisplayName(name: string): string {
  return name
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s*[|•·].*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_IMG_DATA_URI_CHARS = 4_000_000;

/** Inlines a remote image as a data URI so Puppeteer never waits on an in-page request before screenshotting. */
function fetchImageAsBase64(url: string, hops = 0): Promise<string | null> {
  if (!/^https?:\/\//i.test(url) || hops > 4) return Promise.resolve(null);
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 12000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchImageAsBase64(new URL(res.headers.location, url).toString(), hops + 1).then(resolve);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const mime = res.headers['content-type'] || 'image/jpeg';
        const uri = `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
        resolve(uri.length <= MAX_IMG_DATA_URI_CHARS ? uri : null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── Tweet fetching ─────────────────────────────────────────────────────────
interface Tweet {
  id: string;
  text: string;          // cleaned, original language
  lang: string;
  handle: string;        // screen_name, no @
  displayName: string;
  avatarUrl: string;
  url: string;
}

async function fetchTweet(id: string): Promise<Tweet> {
  const res = await fetch(`${TWEET_API}/${id}`);
  if (!res.ok) throw new Error(`react-tweet API HTTP ${res.status} (deleted, private, or bad id?)`);
  const body = await res.json() as any;
  const data = body?.data;
  if (!data || data.__typename !== 'Tweet' || !data.user) throw new Error('Tweet not available (deleted, protected or age-restricted).');
  const text = cleanTweetText(data);
  if (!text) throw new Error('Tweet has no text (media-only?).');
  return {
    id,
    text,
    lang: data.lang ?? 'und',
    handle: data.user.screen_name,
    displayName: cleanDisplayName(data.user.name ?? data.user.screen_name),
    // "_normal" is a 48px thumbnail; the same path with "_400x400" is the real photo.
    avatarUrl: String(data.user.profile_image_url_https ?? '').replace(/_normal(\.\w+)$/, '_400x400$1'),
    url: `https://x.com/${data.user.screen_name}/status/${id}`,
  };
}

// ─── Ollama (local) translation ─────────────────────────────────────────────
async function ollama(prompt: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, options: { temperature: 0.2 }, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json() as any;
  return String(data.message?.content ?? '').trim();
}

async function assertOllama() {
  try {
    await fetch('http://localhost:11434/api/tags');
  } catch (e: any) {
    throw new Error(`Ollama not reachable at localhost:11434 — is it running? (${e.message})`);
  }
}

async function translateQuote(text: string, author: string): Promise<string> {
  const out = (await ollama(`أنت مترجم أدبي محترف. ترجم الاقتباس التالي إلى العربية الفصحى بأسلوب بليغ وسلس، محافظًا على المعنى والنبرة كما هما، دون إضافة أي شيء أو شرح. اكتب أسماء الأعلام بالحروف العربية.

الكاتب: ${author}
الاقتباس: ${text}

أجب بالترجمة العربية فقط، بدون علامات اقتباس أو مقدمات أو ملاحظات.`))
    .replace(/^```\w*\n?|\n?```$/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/^[\s"“”«»]+|[\s"“”«»]+$/g, '')
    .trim();
  if (!out || !isArabic(out)) throw new Error(`Translation did not come back as Arabic: "${out.slice(0, 80)}"`);
  return out;
}

async function transliterateName(name: string): Promise<string> {
  const out = (await ollama(`انقل الاسم التالي إلى نقحرة عربية شائعة الاستخدام. أجب بالاسم المنقول فقط، بدون أي شرح أو علامات اقتباس:\n${name}`))
    .replace(/\s*\n[\s\S]*$/, '')
    .replace(/^[\s"“”«»]+|[\s"“”«»]+$/g, '')
    .trim();
  if (!out || !isArabic(out)) throw new Error(`Name transliteration did not come back as Arabic: "${out.slice(0, 80)}"`);
  return out;
}

// ─── quotes.json ────────────────────────────────────────────────────────────
function loadQuotes(): QuotesConfig {
  return JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf-8'));
}

function saveQuotes(config: QuotesConfig) {
  fs.writeFileSync(QUOTES_FILE, JSON.stringify(config, null, 2) + '\n');
}

/** Same scheme as import-goodreads-quotes.ts, so ids stay stable and collision-free across both importers. */
function makeId(authorSlug: string, cleanedText: string): string {
  return crypto.createHash('md5').update(`${authorSlug}::${cleanedText}`).digest('hex').slice(0, 16);
}

function findAuthor(config: QuotesConfig, handle: string): QuoteAuthor | undefined {
  return config.authors.find((a) => a.twitterHandle?.toLowerCase() === handle.toLowerCase());
}

function newAuthorSlug(config: QuotesConfig, name: string, handle: string): string {
  const base = slugifyTag(name) || handle;
  return config.authors.some((a) => a.slug === base) ? `${base}-${handle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}` : base;
}

function findQuote(config: QuotesConfig, id: string): QuoteItem | undefined {
  for (const a of config.authors) {
    const hit = a.quotes.find((q) => q.id === id) ?? a.books.flatMap((b) => b.quotes).find((q) => q.id === id);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Card (RTL / Arabic, cream "paper" look) ────────────────────────────────
interface Card {
  quote: string;
  author: string;
  avatarUri: string | null;
}

function buildCardHtml(c: Card): string {
  const fontParam = `${QUOTE_FONT.trim().replace(/\s+/g, '+')}:wght@${QUOTE_WEIGHT}`;
  const avatar = c.avatarUri
    ? `<div class="avatar"><img src="${c.avatarUri}" alt=""/></div>`
    : `<div class="avatar"><span>${xe(Array.from(c.author)[0] ?? '')}</span></div>`;
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${fontParam}&family=Amiri:wght@700&family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;font-family:"Cairo",sans-serif;overflow:hidden}
  .card{position:relative;width:${W}px;height:${H}px;background:#f0e6d3;direction:rtl;overflow:hidden}

  .avatar{position:absolute;top:74px;left:412px;width:176px;height:176px;border-radius:50%;
    border:1.5px solid #c6b28c;padding:6px;background:#f0e6d3;display:flex;align-items:center;justify-content:center}
  .avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;background:#fff;display:block}
  .avatar span{width:100%;height:100%;border-radius:50%;background:#e3d5b8;color:#6b5a3a;font-size:72px;font-weight:700;display:flex;align-items:center;justify-content:center}

  .sep{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:18px;direction:ltr}
  .sep i{display:block;width:83px;height:1px;background:#b9a883}
  .sep b{font-family:"Amiri",serif;font-size:44px;line-height:1;color:#b39d72;font-weight:700;height:26px;display:block;overflow:visible}
  .sep.top{top:299px}
  .sep.bottom{top:578px}

  .quote-box{position:absolute;top:330px;height:232px;left:100px;right:100px;display:flex;align-items:center;justify-content:center}
  .quote{font-family:"${xe(QUOTE_FONT)}","Cairo",serif;color:#2a2521;font-weight:${QUOTE_WEIGHT};text-align:center;line-height:1.75;font-size:${MAX_QUOTE_FONT}px;width:100%;text-wrap:balance}

  .author{position:absolute;top:636px;left:0;right:0;text-align:center;font-size:26px;font-weight:600;color:#2a2521}
  .footer{position:absolute;top:762px;left:0;right:0;text-align:center;font-size:20px;font-weight:600;color:#9d8d69;direction:ltr}
</style>
</head><body>
<div class="card">
  ${avatar}
  <div class="sep top"><i></i><b>”</b><i></i></div>
  <div class="quote-box"><p class="quote" id="q">${xe(c.quote)}</p></div>
  <div class="sep bottom"><i></i><b>“</b><i></i></div>
  <div class="author">${xe(c.author)}</div>
  <div class="footer">quotes.elhellal.com</div>
</div>
</body></html>`;
}

// ─── Clipboard (macOS) ──────────────────────────────────────────────────────
/** Puts the PNG itself (not the file path) on the clipboard, so it pastes straight into the X composer. */
function copyImageToClipboard(file: string): boolean {
  if (process.platform !== 'darwin') return false;
  const script = `set the clipboard to (read (POSIX file "${file.replace(/["\\]/g, '\\$&')}") as «class PNGf»)`;
  return spawnSync('osascript', ['-e', script], { stdio: 'ignore' }).status === 0;
}

// ─── Text outputs ───────────────────────────────────────────────────────────
function buildTweetText(authorName: string, quoteUrl: string): string {
  return `${authorName}\n\n${quoteUrl}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
interface Result {
  tweet: Tweet;
  arabicText: string;
  authorName: string;
  authorSlug: string;
  quoteId: string;
  translated: boolean;
  saved: 'new' | 'existing' | 'skipped';
}

async function resolveTweet(tweet: Tweet, config: QuotesConfig): Promise<Result> {
  const existingAuthor = findAuthor(config, tweet.handle);
  const provisionalSlug = existingAuthor?.slug ?? tweet.handle;
  const quoteId = makeId(existingAuthor?.slug ?? provisionalSlug, tweet.text);

  // Already stored (same author + same original text): reuse — no translation, no duplicate.
  const stored = existingAuthor ? findQuote(config, quoteId) : undefined;
  if (existingAuthor && stored) {
    return { tweet, arabicText: stored.text, authorName: existingAuthor.name, authorSlug: existingAuthor.slug, quoteId, translated: false, saved: 'existing' };
  }

  const needsQuoteTranslation = !TEXT_OVERRIDE && !isArabic(tweet.text);
  const needsNameTranslation = !existingAuthor && !isArabic(tweet.displayName);
  if (needsQuoteTranslation || needsNameTranslation) await assertOllama();

  const authorName = existingAuthor?.name ?? (isArabic(tweet.displayName) ? tweet.displayName : await transliterateName(tweet.displayName));
  const arabicText = TEXT_OVERRIDE?.trim() || (needsQuoteTranslation ? await translateQuote(tweet.text, authorName) : tweet.text);
  const authorSlug = existingAuthor?.slug ?? newAuthorSlug(config, authorName, tweet.handle);
  // A brand-new author gets a real slug now, so the id (which hashes it) must be recomputed.
  const finalId = existingAuthor ? quoteId : makeId(authorSlug, tweet.text);

  return { tweet, arabicText, authorName, authorSlug, quoteId: finalId, translated: needsQuoteTranslation, saved: 'skipped' };
}

function saveResult(config: QuotesConfig, r: Result): Result['saved'] {
  let author = findAuthor(config, r.tweet.handle);
  if (!author) {
    author = {
      slug: r.authorSlug,
      twitterHandle: r.tweet.handle,
      name: r.authorName,
      ...(r.tweet.avatarUrl ? { image: r.tweet.avatarUrl } : {}),
      quotes: [],
      books: [],
    };
    config.authors.push(author);
  }
  if (findQuote(config, r.quoteId)) return 'existing';
  author.quotes.push({ id: r.quoteId, text: r.arabicText, sourceUrl: r.tweet.url });
  return 'new';
}

async function main() {
  const dateKey = DATE_OVERRIDE || isoDate(new Date());
  const config = loadQuotes();

  const ids: string[] = [];
  for (const input of TWEET_INPUTS) {
    const id = parseTweetId(input);
    if (!id) { console.error(`❌  Not a tweet URL or id: ${input}`); process.exit(1); }
    ids.push(id);
  }

  console.log(`\n🐦  Building ${ids.length} quote card(s) for ${dateKey}\n`);

  let browser: Browser | null = null;
  let page: Page | null = null;
  let madeCount = 0;
  let dirty = false;
  let lastImage: string | null = null;

  for (const id of ids) {
    try {
      console.log(`▶  ${id}`);
      const tweet = await fetchTweet(id);
      const r = await resolveTweet(tweet, config);
      console.log(`   @${tweet.handle} → ${r.authorName}${r.translated ? '  (translated)' : ''}${r.saved === 'existing' ? '  (already in quotes.json)' : ''}`);
      console.log(`   «${r.arabicText}»`);

      if (DRY_RUN) continue;

      const avatarUri = tweet.avatarUrl ? await fetchImageAsBase64(tweet.avatarUrl) : null;
      if (!avatarUri) console.warn('   ⚠️  Profile photo could not be fetched — using an initial instead.');

      if (!browser) {
        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-dev-shm-usage'] });
        page = await browser.newPage();
        await page.setViewport({ width: W, height: H, deviceScaleFactor: SCALE });
      }
      const p = page!;

      // 'load' (not 'domcontentloaded') so the Google Fonts stylesheet has applied before we ask for faces.
      await p.setContent(buildCardHtml({ quote: r.arabicText, author: r.authorName, avatarUri }), { waitUntil: 'load', timeout: 20000 }).catch(() => {
        console.warn('   ⚠️  Fonts did not finish loading in time — the card may use a fallback font.');
      });
      const fit = await Promise.race([
        p.evaluate(async (family: string, weight: number, min: number, max: number) => {
          const fonts = (document as any).fonts;
          const ar = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوية';
          await Promise.all([fonts.load(`${weight} 48px "${family}"`, ar), fonts.load('600 24px "Cairo"', ar), fonts.load('700 44px "Amiri"', '“”')]);
          await fonts.ready;
          // Longer quotes shrink until they fit between the two ornaments.
          const q = document.getElementById('q') as HTMLElement;
          const box = q.parentElement as HTMLElement;
          let size = max;
          q.style.fontSize = `${size}px`;
          while (q.scrollHeight > box.clientHeight && size > min) { size -= 1; q.style.fontSize = `${size}px`; }
          return { size, fits: q.scrollHeight <= box.clientHeight };
        }, QUOTE_FONT, QUOTE_WEIGHT, MIN_QUOTE_FONT, MAX_QUOTE_FONT),
        new Promise<null>((res) => setTimeout(() => res(null), 12000)),
      ]);
      if (fit && !fit.fits) console.warn(`   ⚠️  Quote is too long for the card even at ${MIN_QUOTE_FONT}px — it overflows. Shorten it with --text.`);

      if (!NO_SAVE) {
        r.saved = saveResult(config, r);
        dirty = dirty || r.saved === 'new';
      }

      const quoteUrl = `${SITE}/${encodeURIComponent(r.authorSlug)}/${r.quoteId}/`;
      const dir = path.join(OUT_ROOT, dateKey, `quote-${r.quoteId}`);
      fs.mkdirSync(dir, { recursive: true });
      await p.screenshot({ path: path.join(dir, 'quote.png') });
      fs.writeFileSync(path.join(dir, 'tweet.txt'), buildTweetText(r.authorName, quoteUrl), 'utf-8');
      fs.writeFileSync(path.join(dir, 'alt.txt'), `${r.arabicText} — ${r.authorName}`, 'utf-8');
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        date: dateKey, generatedAt: new Date().toISOString(),
        sourceTweet: tweet.url, sourceLang: tweet.lang, originalText: tweet.text, translated: r.translated,
        quote: r.arabicText, author: r.authorName, authorSlug: r.authorSlug, twitterHandle: tweet.handle,
        quoteId: r.quoteId, quoteUrl, savedToQuotesJson: r.saved,
      }, null, 2), 'utf-8');

      console.log(`   ✅  ${path.relative(process.cwd(), dir)}/  ${fit ? `(${fit.size}px)` : ''}${r.saved === 'new' ? '  + added to quotes.json' : ''}`);
      lastImage = path.join(dir, 'quote.png');
      madeCount++;
    } catch (err: any) {
      console.error(`   ❌  ${err.message ?? err}`);
    }
  }

  await browser?.close();
  if (dirty) saveQuotes(config);

  if (DRY_RUN) { console.log('\n🧪  --dry-run: nothing written.'); return; }
  if (madeCount === 0) { console.error('\n❌  Nothing was generated.'); process.exit(1); }

  console.log(`\n🎉  Done — ${madeCount} card(s) in ${path.relative(process.cwd(), path.join(OUT_ROOT, dateKey))}/`);
  if (dirty) console.log('📚  quotes.json updated — deploy before posting so the link in tweet.txt resolves.');
  console.log('📋  Per folder: attach quote.png, paste tweet.txt, add alt.txt as the image description, post.');
  if (lastImage && !NO_COPY) {
    if (copyImageToClipboard(lastImage)) {
      console.log(`✂️   Image copied to clipboard${madeCount > 1 ? ' (the last card only)' : ''} — paste it straight into the post.`);
    } else {
      console.warn('⚠️  Could not copy the image to the clipboard (macOS only).');
    }
  }
}

main().catch((err) => {
  console.error('❌  Failed:', err);
  process.exit(1);
});
