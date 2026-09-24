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

/** Renders one of two distinct card types: a book-sourced quote (cover + badge) or an author-only quote (large quote mark). */
export default function QuoteCard({ quote }: QuoteCardProps) {
    return quote.book ? <BookQuoteCard quote={quote} /> : <AuthorQuoteCard quote={quote} />;
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
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
                    </svg>
                )}
            </ActionButton>

            <ActionButton label="نسخ رابط الاقتباس" onClick={copy(url, setCopiedLink)} done={copiedLink}>
                {copiedLink ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 448 512">
                    <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
                </svg>
            </ShareLink>

            <ShareLink
                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`}
                label="مشاركة عبر X"
                className="quote-action-btn--x"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
            </ShareLink>

            <ShareLink
                href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`}
                label="مشاركة عبر فيسبوك"
                className="quote-action-btn--facebook"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 320 512">
                    <path d="M279.14 288l14.22-92.66h-88.91v-60.13c0-25.35 12.42-50.06 52.24-50.06h40.42V6.26S260.43 0 225.36 0c-73.22 0-121.08 44.38-121.08 124.72v70.62H22.89V288h81.39v224h100.17V288z" />
                </svg>
            </ShareLink>
        </div>
    );
}

function QuoteTags({ tags }: { tags?: string[] }) {
    if (!tags || tags.length === 0) return null;
    return (
        <div className="quote-topics" aria-label="مواضيع الاقتباس">
            {tags.slice(0, 2).map((tag) => (
                <span key={tag} className="quote-topic">{tag}</span>
            ))}
        </div>
    );
}

interface QuoteRowProps {
    quote: FlatQuote;
    /** Hide the author byline when the page itself is already scoped to that author (e.g. an author's quote list). */
    showAuthor?: boolean;
    /** Hide the book byline when the page itself is already scoped to that book. */
    showBook?: boolean;
}

/** quotes.net-style dense list row: quote text as a plain line + a byline, no card chrome. Used on the author/book/tag listing pages instead of the big illustrated QuoteCard. */
export function QuoteRow({ quote, showAuthor = true, showBook = true }: QuoteRowProps) {
    const url = quoteUrl(quote);
    const authorUrl = `/${encodeURIComponent(quote.authorSlug)}/`;
    const bookUrl = quote.bookSlug ? `/book/${encodeURIComponent(quote.bookSlug)}/` : undefined;

    return (
        <li className="quote-row">
            <a href={url} className="quote-row-text-link">
                <blockquote className="quote-row-text">{quote.text}</blockquote>
            </a>
            <div className="quote-row-footer">
                <div className="quote-row-meta">
                    {showAuthor && <a href={authorUrl} className="quote-row-author">{quote.author}</a>}
                    {showAuthor && showBook && quote.book && <span className="quote-row-sep" aria-hidden="true">،</span>}
                    {showBook && quote.book && (
                        bookUrl ? <a href={bookUrl} className="quote-row-book">{quote.book}</a> : <span className="quote-row-book">{quote.book}</span>
                    )}
                    {quote.tags && quote.tags.length > 0 && (
                        <span className="quote-row-tags">
                            {quote.tags.slice(0, 3).map((tag) => (
                                <span key={tag} className="quote-row-tag">#{tag}</span>
                            ))}
                        </span>
                    )}
                </div>
                <QuoteActions quote={quote} />
            </div>
        </li>
    );
}

function AuthorQuoteCard({ quote }: QuoteCardProps) {
    const url = quoteUrl(quote);
    const authorUrl = `/${encodeURIComponent(quote.authorSlug)}/`;
    const tier = sizeTier(quote.text);

    return (
        <li className="link-card quote-card quote-card--author">
            <QuoteActions quote={quote} />
            <a href={url} className="quote-card-body" aria-label={`اقرأ اقتباس ${quote.author} كاملاً`}>
                <span className="quote-mark" aria-hidden="true">&rdquo;</span>
                <blockquote className={`quote-text quote-text-${tier}`}>{quote.text}</blockquote>
                <QuoteTags tags={quote.tags} />
            </a>
            <div className="quote-attribution">
                {quote.authorImage ? (
                    <img
                        src={quote.authorImage}
                        alt={quote.author}
                        className="quote-author-avatar"
                        loading="lazy"
                        width={36}
                        height={36}
                    />
                ) : (
                    <span className="quote-author-avatar quote-author-avatar-fallback" aria-hidden="true">
                        {quote.author.trim().charAt(0)}
                    </span>
                )}
                <div className="quote-attribution-text">
                    <a href={authorUrl} className="quote-author">{quote.author}</a>
                    <span className="quote-kind">اقتباس مباشر</span>
                </div>
            </div>
        </li>
    );
}

function BookQuoteCard({ quote }: QuoteCardProps) {
    const url = quoteUrl(quote);
    const authorUrl = `/${encodeURIComponent(quote.authorSlug)}/`;
    const bookUrl = quote.bookSlug ? `/book/${encodeURIComponent(quote.bookSlug)}/` : authorUrl;
    const tier = sizeTier(quote.text);

    return (
        <li className="link-card quote-card quote-card--book">
            <QuoteActions quote={quote} />
            <a href={url} className="quote-card-body" aria-label={`اقرأ اقتباساً من كتاب ${quote.book} كاملاً`}>
                <div className="quote-book-header">
                    {quote.bookCover ? (
                        <img
                            src={quote.bookCover}
                            alt={quote.book || ''}
                            className="quote-book-thumb"
                            loading="lazy"
                            width={40}
                            height={58}
                        />
                    ) : (
                        <span className="quote-book-thumb quote-book-thumb-fallback" aria-hidden="true">📖</span>
                    )}
                    <span className="quote-book-heading">
                        <span className="quote-book-badge">من كتاب</span>
                        <span className="quote-book-title">{quote.book}</span>
                    </span>
                </div>
                <blockquote className={`quote-text quote-text--book quote-text-${tier}`}>{quote.text}</blockquote>
                <QuoteTags tags={quote.tags} />
            </a>
            <div className="quote-attribution quote-attribution--book">
                {quote.authorImage ? (
                    <img
                        src={quote.authorImage}
                        alt={quote.author}
                        className="quote-author-avatar quote-author-avatar--sm"
                        loading="lazy"
                        width={26}
                        height={26}
                    />
                ) : (
                    <span className="quote-author-avatar quote-author-avatar-fallback quote-author-avatar--sm" aria-hidden="true">
                        {quote.author.trim().charAt(0)}
                    </span>
                )}
                <a href={authorUrl} className="quote-author quote-author--book">{quote.author}</a>
                <a href={bookUrl} className="quote-book-link">الكتاب ←</a>
            </div>
        </li>
    );
}
