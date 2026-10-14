// Renders a picked profile ICON (team logo or country flag) from a stored
// "league:teamId" reference. Shared by the nav chip, the settings preview, and
// the picker so a chosen icon looks identical everywhere.
//
//   - UFA/USAU/PUL/WUL → the team logo on a white tile (logos are designed for
//     light backgrounds; the tile keeps dark-mode legibility)
//   - WFDF             → the country flag emoji, centered
//   - unresolvable     → returns null so the caller shows its initials fallback
//
// PUL logos are remote (R2) URLs only known after a DB fetch, so a PUL icon is
// resolvable here only when the caller passes a `pulLogos` lookup map. On the
// nav render path we don't fetch PUL per page-load; instead the picker
// denormalizes nothing and PUL simply falls back to initials until the map is
// supplied. (The settings surface, which already lists PUL, supplies it.)

import { resolveAvatarIcon, type ResolvedIcon } from '@/lib/profile/avatar-icon';
import { WfdfFlag } from '@/components/wfdf/wfdf-flag';

export function AvatarIconView({
  icon,
  size,
  pulLogos,
}: {
  icon: string | null | undefined;
  /** Rendered diameter in px. */
  size: number;
  pulLogos?: Map<string, { name: string; logoUrl: string | null }>;
}) {
  const resolved = resolveAvatarIcon(icon, pulLogos);
  if (!resolved) return null;
  return <ResolvedIconView resolved={resolved} size={size} />;
}

/** Renders an icon the caller already resolved (the draft room resolves every
 *  owner's icon once, PUL included). */
export function ResolvedIconView({ resolved, size }: { resolved: NonNullable<ResolvedIcon>; size: number }) {
  if (resolved.kind === 'flag') {
    return (
      <span
        className="inline-flex items-center justify-center w-full h-full bg-ink/5"
        style={{ width: size, height: size }}
      >
        <WfdfFlag countryCode={resolved.countryCode} size={Math.round(size * 0.62)} />
      </span>
    );
  }

  // EUF: a pre-resolved flag glyph (its clubs have no crests, and the country is
  // keyed by NAME so there's no code for <WfdfFlag> to look up).
  if (resolved.kind === 'emoji') {
    return (
      <span
        role="img"
        aria-label={resolved.name}
        title={resolved.name}
        className="inline-flex items-center justify-center select-none leading-none"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
      >
        {resolved.emoji}
      </span>
    );
  }

  // Logo on a white tile, contained with a little padding so square crests and
  // wide wordmarks both sit comfortably inside the circle.
  return (
    <span
      className="inline-flex items-center justify-center w-full h-full bg-white"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={resolved.src}
        alt={resolved.name}
        className="w-full h-full object-contain"
        style={{ padding: Math.max(2, Math.round(size * 0.12)) }}
        loading="lazy"
      />
    </span>
  );
}

/** True when the reference resolves to something renderable (without PUL). Used
 *  by callers to decide between the icon and their initials fallback on the
 *  common nav path where no PUL map is available. */
export function iconResolvable(icon: string | null | undefined): boolean {
  return resolveAvatarIcon(icon) !== null;
}
