// "Public" — the fantasy hub's open-leagues section. Server Component reading
// the cached public-leagues list (never a per-request query); the rows and
// the competition filter live in the PublicLeaguesRows client island.

import { getPublicLeaguesCached } from '@/lib/fantasy/public-leagues-cached';
import { getGame } from '@/lib/fantasy/games';
import {
  PublicLeaguesRows,
  type PublicLeagueView,
} from '@/components/fantasy/public-leagues-rows';

function lockLabel(iso: string | null): string {
  if (!iso) return 'In progress';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'In progress';
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  return `Locks ${day}`;
}

export async function PublicLeaguesList() {
  const leagues = await getPublicLeaguesCached().catch(() => []);
  if (leagues.length === 0) return null;

  const rows: PublicLeagueView[] = leagues.map((l) => ({
    leagueId: l.leagueId,
    contestId: l.contestId,
    name: l.name,
    logoUrl: l.logoUrl,
    logoIcon: l.logoIcon,
    logoSrc: getGame(l.competition)?.logoSrc ?? null,
    isOfficial: l.isOfficial,
    open: l.open,
    competition: l.competition,
    competitionLabel: l.competitionDef.shortLabel,
    memberCount: l.memberCount,
    lockLabel: lockLabel(l.nextLockAt),
  }));

  return (
    <section aria-labelledby="public-leagues-heading" className="mb-8 lg:mb-10">
      <h2
        id="public-leagues-heading"
        className="font-display italic text-[22px] lg:text-[26px] font-bold tracking-[-0.02em] leading-[0.95] text-ink"
      >
        Public
      </h2>
      <p className="font-tight text-[12px] text-muted mt-1.5 mb-4">Open leagues anyone can join</p>
      <PublicLeaguesRows rows={rows} />
    </section>
  );
}
