import { useState } from 'react';
import './QuoteCard.css';
import type { FlatQuote } from '../types';

interface QuoteCardProps {
    quote: FlatQuote;
}

/**
 * BrainyQuote-style auto-sizing: short quotes get a big, poster-like
 * treatment; long ones shrink (and get more line-clamp room) so they still
 * read comfortably in the same card footprint instead of overflowing.
 */
function sizeTier(text: string): 'xl' | 'lg' | 'md' | 'sm' {
    const len = text.length;
    if (len <= 50) return 'xl';
    if (len <= 100) return 'lg';
    if (len <= 170) return 'md';
    return 'sm';
}

/**
 * Picture-quote palette: each card gets a stable colour from its id so the
 * wall reads like a mosaic of quote posters (about 40% stay plain paper).
 */
const TONES = ['paper', 'night', 'paper', 'ember', 'sand', 'paper', 'night', 'amber', 'paper', 'ember'] as const;
function toneFor(id: string): (typeof TONES)[number] {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return TONES[h % TONES.length];
}

function quoteUrl(quote: FlatQuote): string {
    return `/${encodeURIComponent(quote.authorSlug)}/${encodeURIComponent(quote.id)}/`;
}

function absoluteQuoteUrl(quote: FlatQuote): string {
    return `https://quotes.elhellal.com${quoteUrl(quote)}`;
}

function shareText(quote: FlatQuote): string {
    return quote.book
        ? `"${quote.text}" — ${quote.author}، ${quote.book}`
        : `"${quote.text}" — ${quote.author}`;
}

function ActionButton({
    label,
    onClick,
    done,
    children,
}: {
    label: string;
    onClick: (e: React.MouseEvent) => void;
    done?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            className={`quote-action-btn${done ? ' quote-action-btn--done' : ''}`}
            aria-label={label}
            title={label}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function ShareLink({
    href,
    label,
    className,
    children,
}: {
    href: string;
    label: string;
    className: string;
    children: React.ReactNode;
}) {
    return (
        <a
            href={href}
            className={`quote-action-btn ${className}`}
            aria-label={label}
            title={label}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
        >
            {children}
        </a>
    );
}

/** Hover/focus-revealed action bar: copy quote text, copy link, and share to WhatsApp / X / Facebook. */
function QuoteActions({ quote }: { quote: FlatQuote }) {
    const [copiedText, setCopiedText] = useState(false);
    const [copiedLink, setCopiedLink] = useState(false);

    const text = shareText(quote);
    const url = absoluteQuoteUrl(quote);

    const copy = (value: string, onDone: (v: boolean) => void) => (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => {
            onDone(true);
            setTimeout(() => onDone(false), 1500);
        });
    };

    return (
        <div className="quote-actions" onClick={(e) => e.stopPropagation()}>
            <ActionButton label="نسخ نص الاقتباس" onClick={copy(text, setCopiedText)} done={copiedText}>
                {copiedText ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
                    </svg>
                )}
            </ActionButton>

            <ActionButton label="نسخ رابط الاقتباس" onClick={copy(url, setCopiedLink)} done={copiedLink}>
                {copiedLink ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                )}
            </ActionButton>

            <ShareLink
                href={`https://api.whatsapp.com/send?text=${encodeURIComponent(`${text} ${url}`)}`}
                label="مشاركة عبر واتساب"
                className="quote-action-btn--whatsapp"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" viewBox="0 0 448 512">
                    <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
                </svg>
            </ShareLink>

            <ShareLink
                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`}
                label="مشاركة عبر X"
                className="quote-action-btn--x"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
            </ShareLink>

            <ShareLink
                href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`}
                label="مشاركة عبر فيسبوك"
                className="quote-action-btn--facebook"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 320 512">
                    <path d="M279.14 288l14.22-92.66h-88.91v-60.13c0-25.35 12.42-50.06 52.24-50.06h40.42V6.26S260.43 0 225.36 0c-73.22 0-121.08 44.38-121.08 124.72v70.62H22.89V288h81.39v224h100.17V288z" />
                </svg>
            </ShareLink>
        </div>
    );
}

function Avatar({ quote, size }: { quote: FlatQuote; size: number }) {
    return quote.authorImage ? (
        <img src={quote.authorImage} alt="" className="avatar" loading="lazy" width={size} height={size} style={{ width: size, height: size }} />
    ) : (
        <span className="avatar avatar--initial" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.45 }}>
            {quote.author.trim().charAt(0)}
        </span>
    );
}

interface QuoteRowProps {
    quote: FlatQuote;
    /** Hide the author byline when the page itself is already scoped to that author (e.g. an author's quote list). */
    showAuthor?: boolean;
    /** Hide the book byline when the page itself is already scoped to that book. */
    showBook?: boolean;
}

/** Reading-list row: the quote set in the book face with a quiet byline underneath. Used on the author/book/tag listing pages. */
export function QuoteRow({ quote, showAuthor = true, showBook = true }: QuoteRowProps) {
    const url = quoteUrl(quote);
    const authorUrl = `/${encodeURIComponent(quote.authorSlug)}/`;
    const bookUrl = quote.bookSlug ? `/book/${encodeURIComponent(quote.bookSlug)}/` : undefined;
    const tier = sizeTier(quote.text);

    return (
        <li className="qrow">
            <a href={url} className="qrow-link">
                <blockquote className={`qrow-text qrow-text-${tier}`}>{quote.text}</blockquote>
            </a>
            <div className="qrow-foot">
                <div className="qrow-meta">
                    {showAuthor && (
                        <a href={authorUrl} className="qrow-author">
                            <Avatar quote={quote} size={24} />
                            {quote.author}
                        </a>
                    )}
                    {showBook && quote.book && (
                        bookUrl
                            ? <a href={bookUrl} className="qrow-book">«{quote.book}»</a>
                            : <span className="qrow-book">«{quote.book}»</span>
                    )}
                    {quote.tags && quote.tags.length > 0 && (
                        <span className="qrow-tags">
                            {quote.tags.slice(0, 3).map((tag) => (
                                <span key={tag}>#{tag}</span>
                            ))}
                        </span>
                    )}
                </div>
                <QuoteActions quote={quote} />
            </div>
        </li>
    );
}

/** Masonry card: quote in the book face, author (and source book) in a footer strip. */
export default function QuoteCard({ quote }: QuoteCardProps) {
    const url = quoteUrl(quote);
    const authorUrl = `/${encodeURIComponent(quote.authorSlug)}/`;
    const bookUrl = quote.bookSlug ? `/book/${encodeURIComponent(quote.bookSlug)}/` : undefined;
    const tier = sizeTier(quote.text);

    return (
        <li className={`qcard qcard--${tier} qcard--${toneFor(quote.id)}`}>
            <a href={url} className="qcard-body">
                <span className="qcard-mark" aria-hidden="true">&ldquo;</span>
                <blockquote className="qcard-text">{quote.text}</blockquote>
            </a>
            <div className="qcard-foot">
                <a href={authorUrl} className="qcard-avatar" tabIndex={-1} aria-hidden="true">
                    <Avatar quote={quote} size={34} />
                </a>
                <span className="qcard-byline">
                    <a href={authorUrl} className="qcard-name">{quote.author}</a>
                    {quote.book && (
                        bookUrl
                            ? <a href={bookUrl} className="qcard-book">«{quote.book}»</a>
                            : <span className="qcard-book">«{quote.book}»</span>
                    )}
                </span>
                <QuoteActions quote={quote} />
            </div>
        </li>
    );
}
