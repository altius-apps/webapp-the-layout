import { StarGlyph } from '@/components/favorites/event-favorite-star';

export function OfficialBadge() {
  return (
    <span title="Official league · run by The Layout" className="inline-flex flex-shrink-0 items-center text-accent">
      <StarGlyph filled size={13} />
      <span className="sr-only">Official league</span>
    </span>
  );
}
