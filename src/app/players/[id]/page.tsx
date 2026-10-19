// /players/[id] — unified UFA + USAU player profile.
//
// One page for one human. Accepts either a UFA slug ("tdecraene") or a
// USAU UUID; the unified profile layer fetches both leagues' data and
// merges by display name. See src/lib/unified-player.ts for the merge.
//
// No league switcher renders here — the profile combines both leagues,
// so toggling between them inside the profile doesn't mean anything. The
// switcher reappears on list/feed pages (/scores, /teams, /players).

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getUnifiedPlayerProfile, type UnifiedPlayerProfile } from '@/lib/unified-player';
import { UnifiedProfile } from '@/components/players/unified-player-profile';
import { DivisionSync } from '@/components/players/division-sync';
import { getApprovedContentForPlayers } from '@/lib/player-content/server';
import { getPlayerConnections } from '@/lib/players/connections';

// ISR: profile data changes only when crons ingest, and user content is
// approved on a human timescale — a 10-min-stale page is fine. This page is
// the app's biggest crawler surface, and rendering it per-request ran the
// ~1s get_player_profile RPC on every hit (pegging DB CPU). The ?from=
// breadcrumb param is handled client-side (FromAwareCrumbs) so nothing here
// opts the route back into dynamic rendering.
export const revalidate = 600;

// Empty list + dynamicParams (default true) = SSG mode with every path
// generated on first request, then served from the full-route cache for the
// revalidate window. Without this export the route stays request-rendered and
// the revalidate above never engages.
export function generateStaticParams(): { id: string }[] {
  return [];
}

interface Props {
  params: { id: string };
}

// One canonical per person. USAU creates an id per event registration and every
// id in the resolved cluster renders the same profile, so all of them point at
// the cluster's smallest id (verified symmetric on prod, 2026-10-18). UFA, PUL
// and WUL have one id per person; cross-league pairs stay separate pages.
function canonicalPlayerId(profile: UnifiedPlayerProfile): string {
  if (profile.anchorLeague !== 'usau') return profile.anchorId;
  const ids = profile.contentRefs.filter((r) => r.kind === 'usau').map((r) => r.ref.toLowerCase());
  return [profile.anchorId.toLowerCase(), ...ids].sort()[0];
}

// No .catch on the profile reads: a DB failure must surface as an uncached 500,
// never as a notFound() that ISR caches as a 404 for a real player.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await getUnifiedPlayerProfile(params.id);
  if (!profile) return { title: 'Player not found · The Layout' };
  return {
    title: `${profile.displayName} · The Layout`,
    // Also drops ?from=, so league-suffixed variants collapse into one page.
    alternates: { canonical: `/players/${canonicalPlayerId(profile)}` },
  };
}

export default async function PlayerProfilePage({ params }: Props) {
  const profile = await getUnifiedPlayerProfile(params.id);
  if (!profile) notFound();

  // Fetch content across ALL of the person's league ids (contentRefs), not just
  // the anchor — so a photo uploaded under any league id shows no matter which
  // url reached the profile. Falls back to the anchor pair when refs is empty.
  const [content, connections] = await Promise.all([
    getApprovedContentForPlayers(
      profile.contentRefs.length > 0
        ? profile.contentRefs
        : [{ kind: profile.anchorLeague, ref: profile.anchorId }],
    ),
    getPlayerConnections(profile.displayName, 5),
  ]);

  return (
    <>
      <DivisionSync division={profile.mostRecentUsauDivision} />
      <UnifiedProfile profile={profile} content={content} connections={connections} />
    </>
  );
}
