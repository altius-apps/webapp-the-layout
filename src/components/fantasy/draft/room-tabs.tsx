'use client';

// Segmented switcher for a draft room's panels on phones (Players / Queue /
// Picks or Results). Inline above the panel, not a fixed bottom bar: the app's
// own bottom nav owns that spot on phones and was covering the room's bar, so
// Queue and Picks were unreachable (2026-10-11).

export function RoomTabs<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
}: {
  tabs: readonly { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-1 mb-4 bg-ink/[0.06] rounded-full p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          aria-pressed={active === t.id}
          className={[
            'flex-1 px-3 py-2 min-h-[44px] rounded-full font-tight text-[11px] font-bold tracking-[0.08em] uppercase transition-colors duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            active === t.id ? 'bg-surface-hi text-ink shadow-soft' : 'text-muted hover:text-ink',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
