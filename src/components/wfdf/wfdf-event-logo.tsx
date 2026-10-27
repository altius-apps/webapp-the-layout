'use client';

// WFDF event logo disc for the events grid — the remote logo when it loads,
// else the year disc. Client-only because it needs onError to swap a dead
// logo URL for the fallback at runtime (a `logoUrl != null` check alone still
// renders a broken image when the URL 404s); the events page otherwise stays a
// Server Component. Mirrors the PlayerHeadshot island pattern.

import { useCallback, useEffect, useRef, useState } from 'react';

interface WfdfEventLogoProps {
  logoUrl: string | null;
  year: number;
  // 'disc' is the events-grid chip (44px, white disc). 'hero' (64px) and
  // 'sticky' (32px, for the frozen event bar) are bare marks — no disc, and
  // they render nothing at all when there's no logo rather than falling back
  // to a year bubble, so the row simply closes up.
  variant?: 'disc' | 'hero' | 'sticky';
}

export function WfdfEventLogo({ logoUrl, year, variant = 'disc' }: WfdfEventLogoProps) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // onError ALONE is not enough on a server-rendered <img>. The markup ships in
  // the HTML, so the browser starts (and can finish) the request before React
  // hydrates and attaches the handler — a logo that 404s early fires its error
  // event into the void and the broken image sticks forever. Verified: with
  // every logo request aborted, naturalWidth was 0 and complete was true, yet
  // no onError ever ran. So re-check the already-settled DOM node on mount.
  const checkSettled = useCallback((node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth === 0) setFailed(true);
  }, []);

  useEffect(() => {
    setFailed(false);
    // Ref callbacks run before the image can finish loading on a fresh mount,
    // so re-check here too — this is the pass that catches the pre-hydration
    // failure.
    checkSettled(imgRef.current);
  }, [logoUrl, checkSettled]);

  const bare = variant === 'hero' || variant === 'sticky';
  const px = variant === 'hero' ? 64 : variant === 'sticky' ? 32 : 44;
  // Hero spans the compact header's title + meta lines on phones — 40px
  // there, 64px beside the full page title on lg+.
  const box =
    variant === 'hero'
      ? 'w-10 h-10 lg:w-16 lg:h-16'
      : variant === 'sticky'
        ? 'w-8 h-8'
        : 'w-11 h-11';

  if (logoUrl && !failed) {
    return (
      <span
        className={[
          'inline-flex items-center justify-center overflow-hidden flex-shrink-0',
          box,
          bare ? '' : 'rounded-full bg-white',
        ].join(' ')}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          // Key by url so a src change across client-side navigations remounts
          // the <img> cleanly rather than reusing the failed DOM node.
          key={logoUrl}
          ref={(node) => {
            imgRef.current = node;
            checkSettled(node);
          }}
          src={logoUrl}
          alt=""
          width={px}
          height={px}
          loading="eager"
          fetchPriority="high"
          onError={() => setFailed(true)}
          className={bare ? 'w-full h-full object-contain' : 'w-full h-full object-contain p-1'}
        />
      </span>
    );
  }

  if (bare) return null;

  return (
    <span className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-ink/[0.06] text-[10px] font-bold text-ink font-tight flex-shrink-0">
      {year}
    </span>
  );
}
