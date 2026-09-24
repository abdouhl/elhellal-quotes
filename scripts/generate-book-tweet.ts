#!/usr/bin/env bun
/**
 * "The book / the lesson" tweet generator (Arabic / RTL) — الهلال
 * ------------------------------------------------------------------
 * Builds the two-image tweet format popularised by @BookNoteApp: image 1 is
 * the book cover, image 2 is a card with one lesson (a quote) from it, and
 * the tweet text is just the two labels spaced apart so each sits above its
 * own image. Same Puppeteer HTML->PNG pipeline and cream "paper" look as
 * scripts/generate-tiktok-slideshow.ts, sized 1080x1350 (4:5).
 *
 * Usage:
 *   bun run scripts/generate-book-tweet.ts
 *   bun run scripts/generate-book-tweet.ts --count 5          # a week of tweets in one go
 *   bun run scripts/generate-book-tweet.ts --book ساق-البامبو  # a specific book
 *   bun run scripts/generate-book-tweet.ts --date 2026-09-20
 *   bun run scripts/generate-book-tweet.ts --flip              # labels right-to-left
 *   bun run scripts/generate-book-tweet.ts --dry-run
 *   bun run scripts/generate-book-tweet.ts --reset-history
 *
 * Selection: books are ranked by the likes of their best lesson-length quote;
 * the top books that haven't been tweeted yet are picked, so a book never
 * repeats until every book has been used (history then wraps around). State
 * lives in x-posts/history.json; a --dry-run does not touch it.
 *
 * Output (x-posts/<date>/<NN>-<book-slug>/, repo root — never inside public/):
 *   1-book.png, 2-lesson.png   — attach in this order
 *   tweet.txt                  — the tweet text (labels spaced apart)
 *   reply.txt                  — optional self-reply linking to the book on quotes.elhellal.com
 *   manifest.json              — what was picked, for your own records
 *
 * Nothing is posted — this only generates the assets. When it finishes (macOS)
 * the tweet text is put on the clipboard; paste it into the X composer, press
 * Enter in the terminal, and the two images are copied — paste them, post.
 * (X takes one kind of content per paste, hence two steps.) The clipboard is
 * for the last tweet if --count > 1. Pass --no-copy to skip it.
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { QuotesConfig } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const COUNT = parseInt(getArg('--count') || '1', 10);
const BOOK_OVERRIDE = getArg('--book');
const DRY_RUN = args.includes('--dry-run');
const RESET_HISTORY = args.includes('--reset-history');
const FLIP = args.includes('--flip');
const NO_COPY = args.includes('--no-copy');
const DATE_OVERRIDE = getArg('--date'); // YYYY-MM-DD
const QUOTES_FILE = getArg('--quotes-file') || path.join(__dirname, '../src/data/quotes.json');
// Deliberately NOT under public/ — Astro copies everything in public/ into dist/, and these
// images are for manual upload to X only; the site never serves them.
const OUT_ROOT = getArg('--out-dir') || path.join(__dirname, '../x-posts');
const HISTORY_FILE = path.join(OUT_ROOT, 'history.json');
const SITE = 'https://quotes.elhellal.com';

if (!Number.isFinite(COUNT) || COUNT < 1 || COUNT > 30) {
  console.error('❌  --count must be a number between 1 and 30.');
  process.exit(1);
}

// ─── Geometry ───────────────────────────────────────────────────────────────
const W = 1080;
const H = 1350;

// Goodreads covers are user-supplied: some are thumbnails, some are landscape photos or scans.
// Anything outside these bounds looks broken at 700px tall, so that book is skipped.
const MIN_COVER_WIDTH = 180;
const MIN_COVER_RATIO = 0.55; // width / height
const MAX_COVER_RATIO = 0.85;

// A lesson has to fit on a card and still read as one thought.
const MIN_LESSON_CHARS = 30;
const MAX_LESSON_CHARS = 200;

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
function cleanLesson(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s*"“”«»]+|[\s*"“”«»]+$/g, '')
    .trim();
}

function lessonSizeTier(text: string): 'xl' | 'lg' | 'md' | 'sm' {
  const len = text.length;
  if (len <= 60) return 'xl';
  if (len <= 110) return 'lg';
  if (len <= 160) return 'md';
  return 'sm';
}

function titleSizeTier(text: string): 'lg' | 'md' | 'sm' {
  const len = text.length;
  if (len <= 22) return 'lg';
  if (len <= 40) return 'md';
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
interface Candidate {
  bookSlug: string;
  bookTitle: string;
  cover: string;
  author: string;
  lessonId: string;
  lesson: string;
  likes: number;
}

/** One candidate per book: its most-liked quote that is a sensible length for a card. */
function loadCandidates(): Candidate[] {
  const data: QuotesConfig = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf-8'));
  const out: Candidate[] = [];
  for (const author of data.authors) {
    for (const book of author.books) {
      if (!book.cover) continue;
      const best = book.quotes
        .map((q) => ({ q, text: cleanLesson(q.text) }))
        .filter(({ text }) => text.length >= MIN_LESSON_CHARS && text.length <= MAX_LESSON_CHARS && !/https?:|www\./i.test(text))
        .sort((a, b) => (b.q.likes ?? 0) - (a.q.likes ?? 0))[0];
      if (!best) continue;
      out.push({
        bookSlug: book.slug,
        bookTitle: book.title,
        cover: book.cover,
        author: author.name,
        lessonId: best.q.id,
        lesson: best.text,
        likes: best.q.likes ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.likes - a.likes);
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

// ─── HTML templates (RTL / Arabic, cream "paper" look shared with the TikTok slides) ─
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

  .kicker{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:700;color:#a85a2c}
  .kicker .dot{width:10px;height:10px;border-radius:50%;background:#c8703f}

  .footer{position:absolute;bottom:44px;left:72px;right:72px;z-index:2;display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:24px;font-weight:700;color:#2b211a;direction:ltr;letter-spacing:.02em}
  .brand span{color:#c8703f}

  /* ── Image 1: the book ── */
  .book-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:36px}
  .cover{height:700px;width:auto;max-width:600px;object-fit:contain;border-radius:6px;display:block;
    box-shadow:0 34px 60px rgba(43,33,26,.34), 0 10px 20px rgba(43,33,26,.22), inset 0 0 0 1px rgba(0,0,0,.08)}
  .book-title{font-family:"Amiri",serif;font-weight:700;color:#2b211a;line-height:1.35;margin-top:54px}
  .book-title.lg{font-size:66px}
  .book-title.md{font-size:54px}
  .book-title.sm{font-size:44px}
  .book-author{margin-top:14px;font-size:30px;font-weight:600;color:#6b4a2c}

  /* ── Image 2: the lesson ── */
  .lesson-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right}
  .qmark{font-family:"Amiri",serif;font-size:190px;line-height:1;color:#c8703f;opacity:.85;height:84px;overflow:visible}
  .lesson{font-family:"Amiri",serif;font-weight:700;color:#2b211a;margin-top:6px}
  .lesson.xl{font-size:78px;line-height:1.55}
  .lesson.lg{font-size:64px;line-height:1.6}
  .lesson.md{font-size:53px;line-height:1.65}
  .lesson.sm{font-size:45px;line-height:1.7}
  .accent-bar{width:76px;height:6px;background:#c8703f;border-radius:3px;margin-top:40px}
  .source{margin-top:26px;font-size:30px;line-height:1.6;color:#5a4c3d}
  .source b{color:#2b211a;font-weight:700}
</style>
</head><body>
${bodyHtml}
</body></html>`;
}

function buildBookSlide(c: Candidate, coverUri: string): string {
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="kicker"><span class="dot"></span>الكتاب</div>
    <div class="book-center">
      <img class="cover" src="${coverUri}" alt=""/>
      <h1 class="book-title ${titleSizeTier(c.bookTitle)}">${xe(c.bookTitle)}</h1>
      <div class="book-author">${xe(c.author)}</div>
    </div>
    <div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>
  </div></div>`);
}

function buildLessonSlide(c: Candidate): string {
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="kicker"><span class="dot"></span>الدرس</div>
    <div class="lesson-center">
      <div class="qmark">”</div>
      <p class="lesson ${lessonSizeTier(c.lesson)}">${xe(c.lesson)}</p>
      <div class="accent-bar"></div>
      <p class="source"><b>${xe(c.author)}</b> · ${xe(c.bookTitle)}</p>
    </div>
    <div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>
  </div></div>`);
}

// ─── Tweet text ─────────────────────────────────────────────────────────────
// The original tweet is two labels padded apart so each lands above its image. X lays the
// media grid out left-to-right, so a leading LRM (U+200E) forces the line LTR: the first label
// sits on the left above image 1 and the second on the right above image 2. --flip drops the
// LRM and lets the Arabic line run right-to-left instead, in case X mirrors the grid for you.
const LABEL_GAP = ' '.repeat(30);
function buildTweetText(): string {
  return `${FLIP ? '' : '‎'}الكتاب${LABEL_GAP}الدرس`;
}

function buildReplyText(c: Candidate): string {
  return `المزيد من اقتباسات «${c.bookTitle}» 👇\n${SITE}/book/${encodeURIComponent(c.bookSlug)}`;
}

// ─── Clipboard (macOS) ──────────────────────────────────────────────────────
// A pasteboard can hold text or files, but X's composer only takes one kind per paste (files win
// when both are present) — so it's two steps: text first, then both images as two file items.
function copyTextToClipboard(text: string): boolean {
  if (process.platform !== 'darwin') return false;
  return spawnSync('pbcopy', { input: text, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }).status === 0;
}

function copyFilesToClipboard(files: string[]): boolean {
  if (process.platform !== 'darwin') return false;
  const script = `ObjC.import('AppKit');
    const pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
    // One pasteboard item per file (like ⌘C on two files in Finder).
    const urls = $(${JSON.stringify(files)}.map(f => $.NSURL.fileURLWithPath(f)));
    if (!pb.writeObjects(urls)) throw new Error('writeObjects failed');
    // The items are handed over lazily: if osascript exits right away only the first one survives.
    $.NSThread.sleepForTimeInterval(1);`;
  return spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { stdio: 'ignore' }).status === 0;
}

/** Resolves on Enter — or immediately if stdin is closed/piped, so non-interactive runs never hang. */
function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once('close', resolve);
    rl.question(prompt, () => { rl.close(); });
  });
}

async function copyTweetToClipboard(dir: string) {
  const text = fs.readFileSync(path.join(dir, 'tweet.txt'), 'utf-8');
  const images = ['1-book.png', '2-lesson.png'].map((f) => path.resolve(dir, f));
  if (!copyTextToClipboard(text)) { console.warn('⚠️  Could not copy to the clipboard (macOS only).'); return; }
  console.log('\n📋  Tweet text copied — paste it into the X composer (⌘V).');
  await waitForEnter('    Then press Enter to copy the two images… ');
  if (copyFilesToClipboard(images)) console.log('🖼️   Both images copied (book, then lesson) — paste them (⌘V).');
  else console.warn('⚠️  Could not copy the images to the clipboard.');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const now = DATE_OVERRIDE ? new Date(`${DATE_OVERRIDE}T12:00:00Z`) : new Date();
  const dateKey = DATE_OVERRIDE || isoDate(now);

  const all = loadCandidates();
  let pool: Candidate[];
  if (BOOK_OVERRIDE) {
    pool = all.filter((c) => c.bookSlug === BOOK_OVERRIDE);
    if (pool.length === 0) {
      console.error(`❌  No usable book with slug "${BOOK_OVERRIDE}" (needs a cover and a ${MIN_LESSON_CHARS}–${MAX_LESSON_CHARS} char quote).`);
      process.exit(1);
    }
  } else {
    const history = loadHistory();
    pool = all.filter((c) => !history.has(c.bookSlug));
    if (pool.length < COUNT) {
      console.log('🔁  Every book has been tweeted — history wrapped around to the top of the list.');
      pool = all;
    }
  }

  console.log(`\n🐦  Building ${Math.min(COUNT, pool.length)} book tweet(s) for ${dateKey}\n`);

  if (DRY_RUN) {
    pool.slice(0, COUNT).forEach((c, i) => console.log(`   ${i + 1}. ${c.bookTitle} — ${c.author}\n      «${c.lesson}» (${c.likes} likes)`));
    console.log('\n🧪  --dry-run: no files written, history not updated.');
    return;
  }

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  async function renderSlide(html: string, file: string) {
    // 'load' (not 'domcontentloaded') so the Google Fonts stylesheet has applied before we ask
    // for faces: earlier, fonts.load()/fonts.ready saw no faces, resolved instantly, and the
    // screenshot silently fell back to Cairo for the Amiri headings.
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {
      console.warn('   ⚠️  Fonts did not finish loading in time — this image may use a fallback font.');
    });
    await Promise.race([
      page.evaluate(async () => {
        const fonts = (document as any).fonts;
        // Belt and braces: the sample text matters, without it only the Latin subset is fetched.
        const ar = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوية';
        await Promise.all([
          fonts.load('700 48px "Amiri"', ar), fonts.load('600 24px "Cairo"', ar), fonts.load('700 24px "Cairo"', ar),
        ]);
        await fonts.ready;
      }),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    // No `clip` — page.screenshot({ clip }) returns a black image in this environment (see the
    // TikTok script); a plain screenshot at a viewport sized exactly W×H captures correctly.
    await page.screenshot({ path: file as `${string}.png` });
  }

  const history = loadHistory();
  const made: Candidate[] = [];
  let lastDir = '';
  const dayDir = path.join(OUT_ROOT, dateKey);

  // Walk the ranked pool until enough tweets are built — a book whose cover can't be fetched is skipped.
  for (const c of pool) {
    if (made.length >= COUNT) break;
    const coverUri = await fetchImageAsBase64(c.cover);
    if (!coverUri) { console.warn(`   ⚠️  Cover fetch failed for «${c.bookTitle}» — skipping.`); continue; }

    const dir = path.join(dayDir, `${String(made.length + 1).padStart(2, '0')}-${c.bookSlug}`);
    fs.mkdirSync(dir, { recursive: true });
    await renderSlide(buildBookSlide(c, coverUri), path.join(dir, '1-book.png'));
    const { w, h } = await page.evaluate(() => {
      const img = document.querySelector('.cover') as HTMLImageElement | null;
      return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
    });
    if (w < MIN_COVER_WIDTH || h === 0 || w / h < MIN_COVER_RATIO || w / h > MAX_COVER_RATIO) {
      console.warn(`   ⚠️  Cover for «${c.bookTitle}» is unusable (${w}×${h}) — skipping.`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    await renderSlide(buildLessonSlide(c), path.join(dir, '2-lesson.png'));
    fs.writeFileSync(path.join(dir, 'tweet.txt'), buildTweetText(), 'utf-8');
    fs.writeFileSync(path.join(dir, 'reply.txt'), buildReplyText(c), 'utf-8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      date: dateKey, generatedAt: new Date().toISOString(),
      book: c.bookTitle, bookSlug: c.bookSlug, author: c.author, lessonId: c.lessonId, lesson: c.lesson,
    }, null, 2), 'utf-8');

    console.log(`   ✅  ${path.relative(process.cwd(), dir)}/\n       «${c.lesson}»`);
    made.push(c);
    lastDir = dir;
    if (!BOOK_OVERRIDE) history.add(c.bookSlug);
  }

  await browser.close();

  if (made.length === 0) {
    console.error('❌  Nothing was generated.');
    process.exit(1);
  }
  if (!BOOK_OVERRIDE) {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([...history], null, 2), 'utf-8');
  }

  console.log(`\n🎉  Done — ${made.length} tweet(s) in ${path.relative(process.cwd(), dayDir)}/`);
  console.log('📋  Per folder: attach 1-book.png then 2-lesson.png, paste tweet.txt, post. reply.txt is an optional self-reply with the link.');
  if (!NO_COPY) {
    if (made.length > 1) console.log(`ℹ️   Clipboard is for the last tweet only (${made.length} were built).`);
    await copyTweetToClipboard(lastDir);
  }
}

main().catch((err) => {
  console.error('❌  Failed:', err);
  process.exit(1);
});
