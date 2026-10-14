import { profanitySpans } from '@/lib/moderation';

export function BlurredText({ text }: { text: string }) {
  const spans = profanitySpans(text);
  if (spans.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    if (s.start > cursor) parts.push(text.slice(cursor, s.start));
    parts.push(
      <span key={i} className="blur-[3px] select-none" aria-label="hidden word">
        {text.slice(s.start, s.end)}
      </span>,
    );
    cursor = s.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
