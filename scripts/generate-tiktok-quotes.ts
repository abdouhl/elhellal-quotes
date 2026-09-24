#!/usr/bin/env bun
/**
 * TikTok "quotes" slideshow generator (Arabic / RTL) — الهلال
 * -----------------------------------------------------------
 * Renders a TikTok photo-carousel of ~10 quotes from ONE book or ONE author:
 * a cover slide (the book cover / author photo), one slide per quote, and a
 * save/follow call-to-action slide. Same Puppeteer HTML->PNG pipeline and cream
 * "paper" look as scripts/generate-tiktok-slideshow.ts and
 * scripts/generate-book-tweet.ts, sized 1080x1350 (4:5).
 *
 * Usage:
 *   bun run scripts/generate-tiktok-quotes.ts                        # 1 book slideshow
 *   bun run scripts/generate-tiktok-quotes.ts --type author          # 1 author slideshow
 *   bun run scripts/generate-tiktok-quotes.ts --count 5              # 5 slideshows in one go
 *   bun run scripts/generate-tiktok-quotes.ts --book ساق-البامبو     # a specific book
 *   bun run scripts/generate-tiktok-quotes.ts --author سعود-السنعوسي  # a specific author
 *   bun run scripts/generate-tiktok-quotes.ts --quotes 8             # quotes per slideshow (default 10)
 *   bun run scripts/generate-tiktok-quotes.ts --date 2026-09-20
 *   bun run scripts/generate-tiktok-quotes.ts --dry-run
 *   bun run scripts/generate-tiktok-quotes.ts --reset-history
 *
 * Selection: books (or authors) are ranked by the combined likes of their best
 * --quotes quotes; the top ones that haven't been used yet are picked, so a
 * book/author never repeats until all have been used (history then wraps
 * around). State lives in tiktok-slides/quotes/history.json; a --dry-run does
 * not touch it. Within a slideshow the quotes run from the most-liked down, so
 * the strongest ones come first (TikTok viewers drop off fast).
 *
 * Output (tiktok-slides/quotes/<date>/<NN>-<slug>/, repo root — never inside public/):
 *   01-cover.png, 02-quote.png ... NN-quote.png, NN-cta.png   — upload in this order
 *   caption.txt                                                — caption + hashtags
 *   manifest.json                                              — what was picked
 *
 * TikTok has no public API for a personal account to post a photo carousel —
 * this only generates the assets. Upload via the TikTok app (Post > Photo, add
 * all files in order, paste the caption).
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import type { QuotesConfig } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const TYPE = (getArg('--type') || (getArg('--author') ? 'author' : 'book')) as 'book' | 'author';
const COUNT = parseInt(getArg('--count') || '1', 10);
const QUOTES_PER = parseInt(getArg('--quotes') || '10', 10);
const BOOK_OVERRIDE = getArg('--book');
const AUTHOR_OVERRIDE = getArg('--author');
const DRY_RUN = args.includes('--dry-run');
const RESET_HISTORY = args.includes('--reset-history');
const DATE_OVERRIDE = getArg('--date'); // YYYY-MM-DD
const QUOTES_FILE = getArg('--quotes-file') || path.join(__dirname, '../src/data/quotes.json');
// Deliberately NOT under public/ — Astro copies everything in public/ into dist/, and these
// images are for manual upload to TikTok only; the site never serves them.
const OUT_ROOT = getArg('--out-dir') || path.join(__dirname, '../tiktok-slides/quotes');
const HISTORY_FILE = path.join(OUT_ROOT, 'history.json');

if (TYPE !== 'book' && TYPE !== 'author') {
  console.error('❌  --type must be "book" or "author".');
  process.exit(1);
}
if (!Number.isFinite(COUNT) || COUNT < 1 || COUNT > 20) {
  console.error('❌  --count must be a number between 1 and 20.');
  process.exit(1);
}
if (!Number.isFinite(QUOTES_PER) || QUOTES_PER < 3 || QUOTES_PER > 20) {
  console.error('❌  --quotes must be a number between 3 and 20 (TikTok allows 35 slides; cover + CTA take two).');
  process.exit(1);
}

// ─── Geometry ───────────────────────────────────────────────────────────────
const W = 1080;
const H = 1350; // 4:5 — same ratio as the other TikTok/X scripts

// Goodreads covers are user-supplied: some are thumbnails, some landscape scans. Outside these
// bounds a book cover looks broken at 640px tall, so that book is skipped (author photos are
// cropped into a circle, so they only need a minimum size).
const MIN_COVER_WIDTH = 180;
const MIN_COVER_RATIO = 0.55; // width / height
const MAX_COVER_RATIO = 0.85;
const MIN_PHOTO_WIDTH = 100;

// A quote has to fit on a slide and still read as one thought.
const MIN_QUOTE_CHARS = 30;
const MAX_QUOTE_CHARS = 190;

// ─── Helpers ────────────────────────────────────────────────────────────────
function xe(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Goodreads quotes carry stray wrapper marks and odd whitespace; normalise before rendering. */
function cleanQuote(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s*"“”«»]+|[\s*"“”«»]+$/g, '')
    .trim();
}

/** Loose key for spotting the same quote entered twice (diacritics / punctuation / spacing differ). */
function dedupeKey(text: string): string {
  return text.replace(/[ً-ْٰـ]/g, '').replace(/[^ء-يa-z0-9]/gi, '').slice(0, 40);
}

function quoteSizeTier(text: string): 'xl' | 'lg' | 'md' | 'sm' {
  const len = text.length;
  if (len <= 60) return 'xl';
  if (len <= 110) return 'lg';
  if (len <= 160) return 'md';
  return 'sm';
}

function titleSizeTier(text: string): 'lg' | 'md' | 'sm' {
  const len = text.length;
  if (len <= 18) return 'lg';
  if (len <= 34) return 'md';
  return 'sm';
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

// ─── Data loading ───────────────────────────────────────────────────────────
interface SlideQuote {
  id: string;
  text: string;
  likes: number;
  /** Where this quote comes from, shown under it — the author in book mode, author · book in author mode. */
  source: string;
}

interface Subject {
  type: 'book' | 'author';
  slug: string;
  /** Book title, or author name. */
  title: string;
  author: string;
  authorSlug: string;
  image: string; // book cover / author photo
  quotes: SlideQuote[]; // best-first, already trimmed to QUOTES_PER
  score: number;
}

/** Picks the QUOTES_PER most-liked quotes that fit a slide, dropping duplicates and link-spam. */
function pickQuotes(raw: { id: string; text: string; likes?: number; source: string }[]): SlideQuote[] {
  const seen = new Set<string>();
  const out: SlideQuote[] = [];
  const sorted = raw
    .map((q) => ({ ...q, text: cleanQuote(q.text), likes: q.likes ?? 0 }))
    .filter((q) => q.text.length >= MIN_QUOTE_CHARS && q.text.length <= MAX_QUOTE_CHARS && !/https?:|www\./i.test(q.text))
    .sort((a, b) => b.likes - a.likes);
  for (const q of sorted) {
    const key = dedupeKey(q.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: q.id, text: q.text, likes: q.likes, source: q.source });
    if (out.length >= QUOTES_PER) break;
  }
  return out;
}

function loadSubjects(): Subject[] {
  const data: QuotesConfig = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf-8'));
  const out: Subject[] = [];

  for (const author of data.authors) {
    if (TYPE === 'book') {
      for (const book of author.books) {
        if (!book.cover) continue;
        const quotes = pickQuotes(book.quotes.map((q) => ({ ...q, source: author.name })));
        if (quotes.length < QUOTES_PER) continue;
        out.push({
          type: 'book', slug: book.slug, title: book.title, author: author.name, authorSlug: author.slug,
          image: book.cover, quotes, score: quotes.reduce((s, q) => s + q.likes, 0),
        });
      }
    } else {
      if (!author.image) continue;
      const all = [
        ...author.quotes.map((q) => ({ ...q, source: author.name })),
        ...author.books.flatMap((b) => b.quotes.map((q) => ({ ...q, source: `${author.name} · ${b.title}` }))),
      ];
      const quotes = pickQuotes(all);
      if (quotes.length < QUOTES_PER) continue;
      out.push({
        type: 'author', slug: author.slug, title: author.name, author: author.name, authorSlug: author.slug,
        image: author.image, quotes, score: quotes.reduce((s, q) => s + q.likes, 0),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function loadHistory(): Set<string> {
  if (RESET_HISTORY) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

// ─── HTML templates (RTL / Arabic, cream "paper" look shared with the other slides) ─
function slideDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;font-family:"Cairo",sans-serif;overflow:hidden}
  .slide{
    position:relative;width:${W}px;height:${H}px;overflow:hidden;direction:rtl;
    background:#f4ecdd;
    background-image:
      radial-gradient(circle at 15% 8%, rgba(200,112,63,0.10), transparent 42%),
      radial-gradient(circle at 90% 95%, rgba(200,112,63,0.08), transparent 45%);
    display:flex;flex-direction:column;
  }
  .grain{position:absolute;inset:0;opacity:.5;pointer-events:none;
    background-image:radial-gradient(rgba(60,45,30,.05) 1px, transparent 1px), radial-gradient(rgba(60,45,30,.035) 1.2px, transparent 1.2px);
    background-size:5px 5px, 11px 11px; background-position:0 0, 3px 4px;}
  .pad{position:relative;flex:1;display:flex;flex-direction:column;padding:72px 72px 56px}

  .topbar{display:flex;align-items:center;justify-content:space-between}
  .kicker{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:700;color:#a85a2c}
  .kicker .dot{width:10px;height:10px;border-radius:50%;background:#c8703f}
  .counter{font-size:26px;font-weight:600;color:rgba(43,33,26,.4);direction:ltr}

  .footer{position:absolute;bottom:44px;left:72px;right:72px;z-index:2;display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:24px;font-weight:700;color:#2b211a;direction:ltr;letter-spacing:.02em}
  .brand span{color:#c8703f}
  .swipe{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:600;color:#6b4a2c}

  /* ── Cover slide ── */
  .cover-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:70px}
  .cover-img{height:600px;width:auto;max-width:520px;object-fit:contain;border-radius:6px;display:block;
    box-shadow:0 34px 60px rgba(43,33,26,.34), 0 10px 20px rgba(43,33,26,.22), inset 0 0 0 1px rgba(0,0,0,.08)}
  .cover-photo{width:400px;height:400px;border-radius:50%;object-fit:cover;object-position:center top;display:block;
    border:10px solid #f4ecdd;box-shadow:0 30px 56px rgba(43,33,26,.32), 0 0 0 3px rgba(200,112,63,.55)}
  .cover-headline{font-family:"Amiri",serif;font-weight:700;color:#2b211a;line-height:1.4;margin-top:50px;font-size:62px}
  .cover-headline .accent{color:#c8703f}
  .cover-title{font-family:"Amiri",serif;font-weight:700;color:#a85a2c;line-height:1.35;margin-top:10px}
  .cover-title.lg{font-size:54px}
  .cover-title.md{font-size:46px}
  .cover-title.sm{font-size:38px}
  .cover-by{margin-top:12px;font-size:28px;font-weight:600;color:#6b4a2c}

  /* ── Quote slides ── */
  .quote-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right;padding-bottom:40px}
  .qmark{font-family:"Amiri",serif;font-size:190px;line-height:1;color:#c8703f;opacity:.85;height:84px;overflow:visible}
  .quote{font-family:"Amiri",serif;font-weight:700;color:#2b211a;margin-top:6px}
  .quote.xl{font-size:78px;line-height:1.55}
  .quote.lg{font-size:64px;line-height:1.6}
  .quote.md{font-size:53px;line-height:1.65}
  .quote.sm{font-size:45px;line-height:1.7}
  .accent-bar{width:76px;height:6px;background:#c8703f;border-radius:3px;margin-top:40px}
  .source{margin-top:26px;font-size:30px;line-height:1.6;color:#5a4c3d}
  .source b{color:#2b211a;font-weight:700}

  /* ── CTA slide ── */
  .cta-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:60px}
  .cta-thumb{height:260px;width:auto;max-width:210px;object-fit:contain;border-radius:5px;display:block;
    box-shadow:0 22px 40px rgba(43,33,26,.3), 0 6px 14px rgba(43,33,26,.2), inset 0 0 0 1px rgba(0,0,0,.08)}
  .cta-thumb.round{width:220px;height:220px;max-width:none;border-radius:50%;object-fit:cover;object-position:center top;border:8px solid #f4ecdd;box-shadow:0 22px 40px rgba(43,33,26,.3), 0 0 0 3px rgba(200,112,63,.55)}
  .cta-title{font-family:"Amiri",serif;font-weight:700;font-size:80px;line-height:1.35;color:#2b211a;margin-top:44px}
  .cta-title .accent{color:#c8703f}
  .cta-sub{margin-top:22px;font-size:32px;line-height:1.7;color:#5a4c3d;max-width:820px}
  .cta-actions{display:flex;gap:18px;margin-top:44px}
  .pill{padding:16px 34px;border-radius:50px;font-size:30px;font-weight:700}
  .pill.solid{background:#c8703f;color:#fff}
  .pill.line{border:2px solid rgba(43,33,26,.28);color:#2b211a}
  .cta-url{margin-top:38px;font-size:34px;font-weight:800;color:#2b211a;direction:ltr;letter-spacing:.02em}
  .cta-url span{color:#c8703f}
</style>
</head><body>
${bodyHtml}
</body></html>`;
}

const footerHtml = `<div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>`;

function buildCoverSlide(s: Subject, imageUri: string): string {
  const isBook = s.type === 'book';
  const img = isBook
    ? `<img class="cover-img" src="${imageUri}" alt=""/>`
    : `<img class="cover-photo" src="${imageUri}" alt=""/>`;
  const headline = isBook
    ? `${s.quotes.length} اقتباسات <span class="accent">من كتاب</span>`
    : `أجمل <span class="accent">${s.quotes.length}</span> اقتباسات`;
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="topbar"><div class="kicker"><span class="dot"></span>${isBook ? 'اقتباسات الكتب' : 'اقتباسات الكُتّاب'}</div></div>
    <div class="cover-center">
      ${img}
      <h1 class="cover-headline">${headline}</h1>
      <div class="cover-title ${titleSizeTier(s.title)}">${xe(s.title)}</div>
      ${isBook ? `<div class="cover-by">${xe(s.author)}</div>` : ''}
    </div>
    <div class="footer">
      <div class="swipe">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#6b4a2c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        اسحب لليسار
      </div>
      <div class="brand">elhellal<span>.com</span></div>
    </div>
  </div></div>`);
}

function buildQuoteSlide(s: Subject, q: SlideQuote, index: number): string {
  // In book mode the source line is "author · book"; in author mode the quote already carries its own.
  const source = s.type === 'book' ? `${s.author} · ${s.title}` : q.source;
  const [first, ...rest] = source.split(' · ');
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="topbar">
      <div class="kicker"><span class="dot"></span>${xe(s.title)}</div>
      <span class="counter">${index + 1} / ${s.quotes.length}</span>
    </div>
    <div class="quote-center">
      <div class="qmark">”</div>
      <p class="quote ${quoteSizeTier(q.text)}">${xe(q.text)}</p>
      <div class="accent-bar"></div>
      <p class="source"><b>${xe(first)}</b>${rest.length ? ` · ${xe(rest.join(' · '))}` : ''}</p>
    </div>
    ${footerHtml}
  </div></div>`);
}

function buildCtaSlide(s: Subject, imageUri: string): string {
  const isBook = s.type === 'book';
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="topbar"><div class="kicker"><span class="dot"></span>المزيد على الهلال</div></div>
    <div class="cta-center">
      <img class="cta-thumb ${isBook ? '' : 'round'}" src="${imageUri}" alt=""/>
      <h1 class="cta-title"><span class="accent">احفظ</span> المنشور<br/>وتابعنا للمزيد</h1>
      <p class="cta-sub">${isBook ? `اقتباسات أكثر من «${xe(s.title)}»` : `اقتباسات أكثر لـ ${xe(s.title)}`} وآلاف غيرها على الموقع</p>
      <div class="cta-actions"><span class="pill solid">تابع الحساب</span><span class="pill line">الرابط في البايو</span></div>
      <div class="cta-url">elhellal<span>.com</span></div>
    </div>
  </div></div>`);
}

// ─── Caption ────────────────────────────────────────────────────────────────
function hashtagify(s: string): string {
  return '#' + s.replace(/[^ء-يa-zA-Z0-9\s]/g, '').trim().split(/\s+/).join('_');
}

function buildCaption(s: Subject): string {
  const isBook = s.type === 'book';
  const tags = [
    hashtagify(s.title),
    ...(isBook ? [hashtagify(s.author)] : []),
    '#اقتباسات', '#اقتباسات_كتب', '#كتب', '#قراءة', '#الهلال', '#BookTok', '#ArabicQuotes', '#كتاب_عربي',
  ];
  return [
    isBook ? `📖 ${s.quotes.length} اقتباسات من «${s.title}» — ${s.author}` : `✍️ أجمل ${s.quotes.length} اقتباسات — ${s.title}`,
    '',
    'احفظ المنشور وارجع له متى احتجت جملة تشبهك 🔖',
    'المزيد من الاقتباسات على quotes.elhellal.com (الرابط في البايو) 🔗',
    '',
    [...new Set(tags)].join(' '),
  ].join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const now = DATE_OVERRIDE ? new Date(`${DATE_OVERRIDE}T12:00:00Z`) : new Date();
  const dateKey = DATE_OVERRIDE || isoDate(now);
  const historyKey = (s: Subject) => `${s.type}:${s.slug}`;

  const all = loadSubjects();
  let pool: Subject[];
  if (BOOK_OVERRIDE || AUTHOR_OVERRIDE) {
    const slug = (TYPE === 'book' ? BOOK_OVERRIDE : AUTHOR_OVERRIDE)!;
    pool = all.filter((s) => s.slug === slug);
    if (pool.length === 0) {
      console.error(`❌  No usable ${TYPE} with slug "${slug}" (needs an image and at least ${QUOTES_PER} quotes of ${MIN_QUOTE_CHARS}–${MAX_QUOTE_CHARS} chars).`);
      process.exit(1);
    }
  } else {
    const history = loadHistory();
    pool = all.filter((s) => !history.has(historyKey(s)));
    if (pool.length < COUNT) {
      console.log(`🔁  Every ${TYPE} has been used — history wrapped around to the top of the list.`);
      pool = all;
    }
  }

  console.log(`\n🎬  Building ${Math.min(COUNT, pool.length)} TikTok quote slideshow(s) [${TYPE}] for ${dateKey}\n`);

  if (DRY_RUN) {
    pool.slice(0, COUNT).forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.title}${s.type === 'book' ? ` — ${s.author}` : ''}  (${s.quotes.length} quotes, ${s.score} likes)`);
      s.quotes.forEach((q, j) => console.log(`      ${String(j + 1).padStart(2)}. «${q.text.length > 70 ? q.text.slice(0, 70) + '…' : q.text}» (${q.likes})`));
    });
    console.log('\n🧪  --dry-run: no files written, history not updated.');
    return;
  }

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  async function renderSlide(html: string, file: string) {
    // 'load' (not 'domcontentloaded') so the Google Fonts stylesheet has applied before we ask
    // for faces: otherwise fonts.load()/fonts.ready see no faces, resolve instantly, and the
    // screenshot silently falls back to Cairo for the Amiri headings.
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {
      console.warn('   ⚠️  Fonts did not finish loading in time — this image may use a fallback font.');
    });
    await Promise.race([
      page.evaluate(async () => {
        const fonts = (document as any).fonts;
        // The sample text matters: without it only the Latin subset of each face is fetched.
        const ar = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوية';
        await Promise.all([
          fonts.load('700 48px "Amiri"', ar), fonts.load('600 24px "Cairo"', ar),
          fonts.load('700 24px "Cairo"', ar), fonts.load('800 24px "Cairo"', ar),
        ]);
        await fonts.ready;
      }),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    // No `clip` — page.screenshot({ clip }) returns a black image in this environment; a plain
    // screenshot at a viewport sized exactly W×H captures correctly.
    await page.screenshot({ path: file as `${string}.png` });
  }

  const history = loadHistory();
  const made: Subject[] = [];
  const dayDir = path.join(OUT_ROOT, dateKey);

  // Walk the ranked pool until enough slideshows are built — one whose image can't be used is skipped.
  for (const s of pool) {
    if (made.length >= COUNT) break;
    const imageUri = await fetchImageAsBase64(s.image);
    if (!imageUri) { console.warn(`   ⚠️  Image fetch failed for «${s.title}» — skipping.`); continue; }

    const dir = path.join(dayDir, `${String(made.length + 1).padStart(2, '0')}-${s.slug}`);
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const nn = (n: number) => String(n).padStart(2, '0');

    // Cover first: it doubles as the image-quality check (natural size is only known once rendered).
    const coverFile = `${nn(1)}-cover.png`;
    await renderSlide(buildCoverSlide(s, imageUri), path.join(dir, coverFile));
    const { w, h } = await page.evaluate(() => {
      const img = document.querySelector('.cover-img, .cover-photo') as HTMLImageElement | null;
      return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
    });
    const ratio = h ? w / h : 0;
    const bad = s.type === 'book'
      ? w < MIN_COVER_WIDTH || ratio < MIN_COVER_RATIO || ratio > MAX_COVER_RATIO
      : w < MIN_PHOTO_WIDTH || h === 0;
    if (bad) {
      console.warn(`   ⚠️  Image for «${s.title}» is unusable (${w}×${h}) — skipping.`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    files.push(coverFile);

    for (let i = 0; i < s.quotes.length; i++) {
      const f = `${nn(i + 2)}-quote.png`;
      await renderSlide(buildQuoteSlide(s, s.quotes[i], i), path.join(dir, f));
      files.push(f);
    }

    const ctaFile = `${nn(s.quotes.length + 2)}-cta.png`;
    await renderSlide(buildCtaSlide(s, imageUri), path.join(dir, ctaFile));
    files.push(ctaFile);

    fs.writeFileSync(path.join(dir, 'caption.txt'), buildCaption(s), 'utf-8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      date: dateKey, generatedAt: new Date().toISOString(), type: s.type, slug: s.slug, title: s.title, author: s.author,
      slides: files, quotes: s.quotes.map((q) => ({ id: q.id, likes: q.likes, text: q.text })),
    }, null, 2), 'utf-8');

    console.log(`   ✅  ${path.relative(process.cwd(), dir)}/  — ${files.length} slides · ${s.title}`);
    made.push(s);
    if (!BOOK_OVERRIDE && !AUTHOR_OVERRIDE) history.add(historyKey(s));
  }

  await browser.close();

  if (made.length === 0) {
    console.error('❌  Nothing was generated.');
    process.exit(1);
  }
  if (!BOOK_OVERRIDE && !AUTHOR_OVERRIDE) {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([...history], null, 2), 'utf-8');
  }

  console.log(`\n🎉  Done — ${made.length} slideshow(s) in ${path.relative(process.cwd(), dayDir)}/`);
  console.log('📋  Per folder: upload the PNGs in numeric order via the TikTok app (Post > Photo), paste caption.txt.');
}

main().catch((err) => {
  console.error('❌  Failed:', err);
  process.exit(1);
});
