// /fantasy/public — every open public league the viewer isn't in, with the
// competition filter. The hub's Public section shows only the official
// leagues and links here (Hunter, 2026-10-14). Signed-in only, like all league
// data; the list itself loads in the browser with the viewer's session.

import { PageShell } from '@/components/page-shell';
import { PublicLeaguesBrowser } from '@/components/fantasy/public-leagues-list';
import { FantasySignInGate } from '@/components/fantasy/fantasy-sign-in-gate';
import { getServerUserId } from '@/lib/fantasy/server';
import type { Crumb } from '@/components/breadcrumbs';

export const dynamic = 'force-dynamic';

const BREADCRUMBS: Crumb[] = [
  { label: 'Fantasy', href: '/fantasy' },
  { label: 'Public Leagues' },
];

export default async function PublicLeaguesPage() {
  const userId = await getServerUserId().catch(() => null);
  if (!userId) return <FantasySignInGate headline="Sign in to see public leagues." />;

  return (
    <PageShell
      title="Public Leagues"
      eyebrow="Fantasy · Leagues"
      subtitle="Open leagues anyone can join."
      breadcrumbs={BREADCRUMBS}
      hideFooterMobile
      compactHeaderMobile
    >
      <PublicLeaguesBrowser />
    </PageShell>
  );
}
