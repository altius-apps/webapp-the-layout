// /wfdf/players/by-name/[name] — resolves a WFDF roster name to a player.
//
// WFDF isn't an anchor league (its players have no standalone id), so a roster
// name can't link straight to /players/[id]. Instead every WFDF roster name
// links here. We resolve the name to an anchor profile (USAU → UFA); if found,
// we redirect to that unified profile. If not, we render a lightweight
// WFDF-only profile built from the player's WFDF stints so the link is never
// a dead end.

import { redirect, notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { WfdfFlag } from '@/components/wfdf/wfdf-flag';
import { getWfdfPlayerStints } from '@/lib/wfdf/data';
import { resolveWfdfPlayerAnchor } from '@/lib/wfdf/anchor';
import { getPlayerProfileByName } from '@/lib/euf/data';
import { EufFlag } from '@/components/euf/euf-flag';

export const revalidate = 300;

// SSG mode with on-demand paths: without this export the revalidate above
// never engages and every crawler hit re-runs the name-resolution RPCs.
export function generateStaticParams(): { name: string }[] {
  return [];
}

interface Props {
  params: { name: string };
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const name = decodeName(params.name);
  return { title: `${name} · WFDF · The Layout` };
}

export default async function WfdfPlayerByNamePage({ params }: Props) {
  const name = decodeName(params.name);
  if (!name) notFound();

  // 1. Try to resolve to an anchor-league profile and hand off to it.
  const anchor = await resolveWfdfPlayerAnchor(name).catch(() => null);
  if (anchor) redirect(`/players/${anchor.anchorId}?from=wfdf`);

  // 2. No anchor — render a by-name profile from the player's stints, with any
  //    EUCS career merged in so a Europe-only player still sees full history.
  const [stints, eufProfile] = await Promise.all([
    getWfdfPlayerStints(name).catch(() => []),
    getPlayerProfileByName(name).catch(() => null),
  ]);
  if (stints.length === 0) {
    // Known only to EUCS — its by-name profile is the fuller page for them.
    if (eufProfile) redirect(`/euf/players/by-name/${encodeURIComponent(name)}`);
    notFound();
  }

  const totalGoals = stints.reduce((s, x) => s + (x.goals ?? 0), 0);
  const totalAssists = stints.reduce((s, x) => s + (x.assists ?? 0), 0);
  const isChampion = stints.some((s) => s.isChampion);

  return (
    <PageShell
      title={name}
      stickyName={name}
      eyebrow="WFDF · International"
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'WFDF', href: '/wfdf/events' },
        { label: 'Players', href: '/wfdf/players' },
        { label: name },
      ]}
    >
      {/* Career strip */}
      <div className="mb-8 flex flex-wrap items-stretch gap-px bg-bg rounded-card shadow-card overflow-hidden">
        <HeroStat label="WFDF Events" value={stints.length} />
        <HeroStat label="Goals" value={totalGoals} />
        <HeroStat label="Assists" value={totalAssists} />
        {isChampion && <HeroStat label="World Champion" value="★" accent />}
      </div>

      <section aria-labelledby="wfdf-career-heading">
        <h2
          id="wfdf-career-heading"
          className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3 pb-2 border-b border-hairline"
        >
          WFDF Appearances
        </h2>
        <ul className="flex flex-col gap-2">
          {stints.map((s, i) => (
            <li key={`${s.teamId}-${i}`}>
              <Link
                href={`/wfdf/teams/${s.teamId}`}
                prefetch={false}
                className={[
                  'flex items-center gap-3 bg-surface rounded-card px-4 py-3',
                  'shadow-card transition-shadow hover:shadow-lift cursor-pointer no-underline',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                ].join(' ')}
              >
                <span className="text-[13px] font-bold tabular text-faint w-10 flex-shrink-0">
                  {s.year}
                </span>
                <WfdfFlag flagFile={null} countryCode={s.countryCode} size={18} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink font-tight truncate">
                    {s.teamName}
                    {s.isChampion && <span className="text-accent ml-1.5">★</span>}
                  </span>
                  <span className="block text-[11px] text-muted font-tight truncate mt-0.5">
                    {[s.eventName, s.divisionName].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="text-[11px] text-faint font-tight tabular flex-shrink-0">
                  {s.goals != null || s.assists != null
                    ? `${s.goals ?? 0}G · ${s.assists ?? 0}A`
                    : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* EUCS appearances — merged in so the international and European club
          careers read as one person, mirroring the EUF by-name page. */}
      {eufProfile && eufProfile.appearances.length > 0 && (
        <section aria-labelledby="wfdf-eucs-heading" className="mt-8">
          <h2
            id="wfdf-eucs-heading"
            className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3 pb-2 border-b border-hairline"
          >
            EUCS Appearances
          </h2>
          <ul className="flex flex-col gap-2 list-none p-0 m-0">
            {eufProfile.appearances.map((a, i) => (
              <li key={`${a.teamId}-${i}`}>
                <Link
                  href={`/euf/clubs/${encodeURIComponent(a.teamName)}?div=${encodeURIComponent(a.division)}&season=${a.year}`}
                  prefetch={false}
                  className={[
                    'flex items-center gap-3 bg-surface rounded-card px-4 py-3',
                    'shadow-card transition-shadow hover:shadow-lift cursor-pointer no-underline',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  ].join(' ')}
                >
                  <span className="text-[13px] font-bold tabular text-faint w-10 flex-shrink-0">
                    {a.year}
                  </span>
                  <EufFlag countryName={a.countryName} size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold text-ink font-tight truncate">
                      {a.teamName}
                    </span>
                    <span className="block text-[11px] text-muted font-tight truncate mt-0.5">
                      {[a.eventName, a.division].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="text-[11px] text-faint font-tight tabular flex-shrink-0">
                    {a.goals != null || a.assists != null
                      ? `${a.goals ?? 0}G · ${a.assists ?? 0}A`
                      : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

function HeroStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="flex-1 min-w-[88px] flex flex-col items-center justify-center text-center px-3 py-4 bg-surface">
      <span
        className={[
          'tabular text-[22px] font-bold font-tight leading-none tracking-[-0.03em]',
          accent ? 'text-accent' : 'text-ink',
        ].join(' ')}
      >
        {value}
      </span>
      <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight mt-1.5">
        {label}
      </span>
    </div>
  );
}
