// /players/[id]/thread — "The Thread": a player's connection web (teammates,
// shared-history links between them, and paths to elite players). Powered by the
// precomputed player_edges graph (get_player_thread RPC). Name-anchored, like
// the profile it links from.

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getUnifiedPlayerProfile } from '@/lib/unified-player';
import { getPlayerThread } from '@/lib/players/connections';
import { PlayerThreadView } from '@/components/players/player-thread-view';

// ISR: the thread graph reads the precomputed player_edges table and only
// changes on ingest — same crawler-load rationale as the profile page. The
// ?from= passthrough moved client-side (view reads it) to keep this static.
export const revalidate = 600;

// SSG mode with on-demand paths — see the profile page's note.
export function generateStaticParams(): { id: string }[] {
  return [];
}

interface Props {
  params: { id: string };
}

// Kept out of search indexes (robots.ts also disallows it): low search value and
// a graph read on every render. No .catch on the profile reads, same reason as
// the profile page: a DB failure must be an uncached 500, not a cached 404.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await getUnifiedPlayerProfile(params.id);
  if (!profile) return { title: 'The Thread · The Layout', robots: { index: false } };
  return {
    title: `${profile.displayName} — The Thread · The Layout`,
    description: `${profile.displayName}'s connection web: teammates, shared history, and paths to the game's best.`,
    robots: { index: false },
  };
}

export default async function ThreadPage({ params }: Props) {
  const profile = await getUnifiedPlayerProfile(params.id);
  if (!profile) notFound();

  const thread = await getPlayerThread(profile.displayName, 12, 40);

  return (
    <PlayerThreadView
      thread={thread}
      anchorDisplayName={profile.displayName}
      anchorHeadshotUrl={profile.headshotUrl}
      backHref={`/players/${params.id}`}
    />
  );
}
